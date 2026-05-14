import { Worker } from 'node:worker_threads'
import {
  deserializeError,
  type MainToWorker,
  type WorkerToMain,
  type WsCoreConfig,
  type TerminalCause,
  type LogLevel,
} from './ws-worker-protocol'
import type { Logger, TrueConfRequest, TrueConfResponse } from './types'

interface Pending {
  resolve: (v: TrueConfResponse) => void
  reject: (e: Error) => void
  timer?: NodeJS.Timeout
}

export interface WorkerLike {
  postMessage(m: unknown, transfer?: ReadonlyArray<ArrayBuffer>): void
  on(event: 'message', l: (m: unknown) => void): void
  on(event: 'error', l: (err: Error) => void): void
  on(event: 'exit', l: (code: number) => void): void
  once(event: 'exit', l: (code: number) => void): void
  emit(event: string, ...args: unknown[]): boolean
  terminate(): Promise<number>
}

export interface WsWorkerHandleOptions {
  accountId: string
  config: WsCoreConfig
  logger?: Logger
  /** Test seam: optional custom bootstrap URL (defaults to ./ws-worker-bootstrap.mjs) */
  bootstrapUrl?: URL
  /** Test seam: replaces `new Worker(...)` with a fake (used by unit tests). */
  workerFactory?: (url: URL, opts: { workerData: WsCoreConfig }) => WorkerLike
}

export class WsWorkerHandle {
  private worker: WorkerLike | null = null
  private pending = new Map<number, Pending>()
  private nextReqId = 1
  private nextNonce = 1
  private pendingNonces = new Set<number>()
  private appPingTimer: NodeJS.Timeout | null = null
  private fileProgressHandlers = new Map<string, (progress: number) => void>()
  private pushListeners = new Set<(method: string, payload: Record<string, unknown>) => void>()
  private authListeners = new Set<(botUserId: string) => void>()
  private authLostListeners = new Set<(reason?: string) => void>()
  private shuttingDown = false
  private _botUserId: string | null = null

  public onInboundMessage: ((msg: TrueConfRequest) => void | Promise<void>) | null = null
  public onState: ((state: string, detail?: string) => void) | null = null
  public onTerminal: ((cause: TerminalCause) => void) | null = null

  constructor(private readonly opts: WsWorkerHandleOptions) {}

  get botUserId(): string | null { return this._botUserId }

  async start(): Promise<void> {
    this.spawnWorker()
  }

  private spawnWorker(): void {
    const url = this.opts.bootstrapUrl ?? new URL('./ws-worker-bootstrap.mjs', import.meta.url)
    const w: WorkerLike = this.opts.workerFactory
      ? this.opts.workerFactory(url, { workerData: this.opts.config })
      : (new Worker(url, { workerData: this.opts.config }) as unknown as WorkerLike)
    this.worker = w
    w.on('message', (m: unknown) => this.handleMessage(m as WorkerToMain))
    w.on('error', (err: Error) => {
      this.log('error', `[trueconf] worker error (account=${this.opts.accountId}): ${err.message}`)
    })
    w.on('exit', (code: number) => this.handleWorkerExit(code))
    this.startWatchdog()
  }

  private startWatchdog(): void {
    this.appPingTimer = setInterval(() => {
      const nonce = this.nextNonce++
      this.pendingNonces.add(nonce)
      this.worker?.postMessage({ kind: 'appPing', nonce } satisfies MainToWorker)
      const t = setTimeout(() => {
        if (this.pendingNonces.has(nonce) && !this.shuttingDown) {
          this.log('error', `[trueconf] ws-worker unresponsive (account=${this.opts.accountId})`)
          this.terminateAndRespawn('worker_unresponsive')
        }
      }, 15_000)
      t.unref?.()
    }, 5_000)
    this.appPingTimer.unref?.()
  }

  private handleMessage(m: WorkerToMain): void {
    switch (m.kind) {
      case 'ready':
        break
      case 'state':
        this.onState?.(m.state, m.detail)
        break
      case 'auth':
        this._botUserId = m.botUserId
        for (const l of this.authListeners) {
          try { l(m.botUserId) } catch (err) { this.log('warn', `[trueconf] onAuth listener threw: ${err instanceof Error ? err.message : String(err)}`) }
        }
        break
      case 'authLost':
        this._botUserId = null
        for (const l of this.authLostListeners) {
          try { l(m.reason) } catch (err) { this.log('warn', `[trueconf] onAuthLost listener threw: ${err instanceof Error ? err.message : String(err)}`) }
        }
        break
      case 'inbound': {
        const reconstructed = { type: 1, method: m.method, payload: m.payload } as unknown as TrueConfRequest
        Promise.resolve(this.onInboundMessage?.(reconstructed)).catch((err) => {
          this.log('error', `[trueconf] inbound handler failed: ${err instanceof Error ? err.message : String(err)}`)
        })
        break
      }
      case 'push':
        for (const l of this.pushListeners) {
          try { l(m.method, m.payload) } catch (err) { this.log('warn', `[trueconf] onPush listener threw: ${err instanceof Error ? err.message : String(err)}`) }
        }
        break
      case 'response': {
        const p = this.pending.get(m.reqId)
        if (!p) return
        this.pending.delete(m.reqId)
        if (p.timer) clearTimeout(p.timer)
        if (m.ok) p.resolve(m.data as TrueConfResponse)
        else p.reject(deserializeError(m.error))
        break
      }
      case 'fileProgress':
        this.fileProgressHandlers.get(m.fileId)?.(m.progress)
        break
      case 'appPong':
        this.pendingNonces.delete(m.nonce)
        break
      case 'terminal':
        this.onTerminal?.(m.cause)
        break
      case 'log':
        this.log(m.level, m.msg, m.meta)
        break
    }
  }

  // Signature matches `WsClientLike` in src/outbound-queue.ts so OutboundQueue
  // accepts WsWorkerHandle without further changes. `traceId` is accepted but
  // ignored at the handle level — the wire-protocol's `reqId` already covers
  // request-response correlation.
  sendRequest(
    method: string,
    payload: Record<string, unknown>,
    traceId?: string,
    opts?: { timeoutMs?: number; transfer?: ReadonlyArray<ArrayBuffer> },
  ): Promise<TrueConfResponse> {
    if (!this.worker || this.shuttingDown) return Promise.reject(new Error('worker not running'))
    const reqId = this.nextReqId++
    return new Promise<TrueConfResponse>((resolve, reject) => {
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            if (this.pending.delete(reqId)) reject(new Error(`request ${method} timed out`))
          }, opts.timeoutMs)
        : undefined
      this.pending.set(reqId, { resolve, reject, timer })
      const msg: MainToWorker = { kind: 'sendRequest', reqId, method, payload, traceId, timeoutMs: opts?.timeoutMs }
      if (opts?.transfer && opts.transfer.length > 0) this.worker!.postMessage(msg, opts.transfer)
      else this.worker!.postMessage(msg)
    })
  }

  async forceReconnect(reason: string): Promise<void> {
    this.worker?.postMessage({ kind: 'forceReconnect', reason } satisfies MainToWorker)
  }

  /** Test seam: terminates the WS socket inside the worker. */
  terminate(): void {
    this.worker?.postMessage({ kind: 'terminate' } satisfies MainToWorker)
  }

  onPush(listener: (method: string, payload: Record<string, unknown>) => void): () => void {
    this.pushListeners.add(listener)
    return () => this.pushListeners.delete(listener)
  }

  onAuth(listener: (botUserId: string) => void): () => void {
    this.authListeners.add(listener)
    return () => this.authListeners.delete(listener)
  }

  onAuthLost(listener: (reason?: string) => void): () => void {
    this.authLostListeners.add(listener)
    return () => this.authLostListeners.delete(listener)
  }

  onFileProgress(fileId: string, handler: (progress: number) => void): void {
    this.fileProgressHandlers.set(fileId, handler)
    this.worker?.postMessage({ kind: 'fileProgressSubscribe', fileId } satisfies MainToWorker)
  }

  offFileProgress(fileId: string): void {
    this.fileProgressHandlers.delete(fileId)
    this.worker?.postMessage({ kind: 'fileProgressUnsubscribe', fileId } satisfies MainToWorker)
  }

  private handleWorkerExit(code: number): void {
    if (this.appPingTimer) {
      clearInterval(this.appPingTimer)
      this.appPingTimer = null
    }
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(Object.assign(new Error('worker exited'), { code: 'WS_WORKER_EXIT', parkable: true }))
    }
    this.pending.clear()
    this.pendingNonces.clear()
    const wasShuttingDown = this.shuttingDown
    this.worker = null
    if (!wasShuttingDown && code !== 0) {
      this.onState?.('reconnecting', `worker exited code=${code}`)
      setTimeout(() => { if (!this.shuttingDown) this.spawnWorker() }, 100).unref()
    } else {
      this.onState?.('closed', 'worker exited')
    }
  }

  private terminateAndRespawn(reason: string): void {
    if (!this.worker || this.shuttingDown) return
    this.log('warn', `[trueconf] respawn worker: ${reason}`)
    this.worker.terminate().catch(() => undefined)
  }

  async close(reason?: string): Promise<void> {
    this.shuttingDown = true
    if (this.appPingTimer) { clearInterval(this.appPingTimer); this.appPingTimer = null }
    const w = this.worker
    if (!w) return
    w.postMessage({ kind: 'shutdown', reason } satisfies MainToWorker)
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { w.terminate().catch(() => undefined); resolve() }, 3_000)
      w.once('exit', () => { clearTimeout(t); resolve() })
    })
    this.worker = null
  }

  private log(level: LogLevel, msg: string, _meta?: unknown): void {
    if (!this.opts.logger) return
    switch (level) {
      case 'debug': break // Logger interface lacks debug() — drop debug messages.
      case 'info': this.opts.logger.info(msg); break
      case 'warn': this.opts.logger.warn(msg); break
      case 'error': this.opts.logger.error(msg); break
    }
  }
}
