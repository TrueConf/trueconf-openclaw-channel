import WebSocket from 'ws'
import { fetch, type Dispatcher, type RequestInit, type Response } from 'undici'
import {
  IdCounter,
  RequestMatcher,
  buildAuthRequest,
  ErrorCode,
  NetworkError,
  DNS_ERROR_CODES,
  DNS_TERMINAL_CODE,
} from './types'
import type {
  TrueConfAccountConfig,
  TrueConfResponse,
  TrueConfRequest,
  OAuthTokenResponse,
  Logger,
} from './types'

// Match TrueConf's own python-trueconf-bot SDK (websockets.connect
// ping_interval=30, ping_timeout=10) — production-tested against the same
// servers we talk to.
const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_PONG_TIMEOUT_MS = 10_000

export function hostPort(config: { serverUrl: string; useTls: boolean; port?: number }): string {
  if (typeof config.serverUrl !== 'string' || config.serverUrl.length === 0) {
    throw new Error('hostPort: serverUrl must be a non-empty string')
  }
  if (config.port !== undefined) {
    if (typeof config.port !== 'number' || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error(`hostPort: invalid port ${JSON.stringify(config.port)}`)
    }
  }
  const port = config.port ?? (config.useTls ? 443 : 4309)
  if (config.useTls && port === 443) return config.serverUrl
  if (!config.useTls && port === 80) return config.serverUrl
  return `${config.serverUrl}:${port}`
}

export function buildWsUrl(config: TrueConfAccountConfig): string {
  return `${config.useTls ? 'wss' : 'ws'}://${hostPort(config)}/websocket/chat_bot/`
}

export function buildTokenUrl(config: TrueConfAccountConfig): string {
  return `${config.useTls ? 'https' : 'http'}://${hostPort(config)}/bridge/api/client/v1/oauth/token`
}

// Pull libuv-style metadata off `err.cause`. fetch wraps a TypeError around
// the underlying ENOTFOUND/ECONNREFUSED/etc. — we want code/syscall/hostname
// to flow through to NetworkError so callers (DNS retry policy, telemetry)
// can branch on them without parsing message strings.
function extractFetchCauseMeta(err: unknown): { code?: string; syscall?: string; hostname?: string } {
  const cause = err instanceof Error ? err.cause : undefined
  if (!cause || typeof cause !== 'object') return {}
  const obj = cause as Record<string, unknown>
  return {
    code: 'code' in obj && typeof obj.code !== 'undefined' ? String(obj.code) : undefined,
    syscall: 'syscall' in obj && typeof obj.syscall !== 'undefined' ? String(obj.syscall) : undefined,
    hostname: 'hostname' in obj && typeof obj.hostname !== 'undefined' ? String(obj.hostname) : undefined,
  }
}

export async function acquireToken(
  config: TrueConfAccountConfig,
  options?: { dispatcher?: Dispatcher },
): Promise<OAuthTokenResponse> {
  let response: Response
  try {
    response = await fetch(buildTokenUrl(config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId ?? 'chat_bot',
        client_secret: config.clientSecret ?? '',
        grant_type: 'password',
        username: config.username,
        password: config.password,
      }),
      ...(options?.dispatcher && { dispatcher: options.dispatcher }),
    } as RequestInit)
  } catch (err) {
    const meta = extractFetchCauseMeta(err)
    const outerMsg = err instanceof Error ? err.message : String(err)
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : ''
    const detail = `${outerMsg}${meta.code ? ` (${meta.code}: ${causeMsg || meta.code})` : causeMsg ? ` (${causeMsg})` : ''}`
    throw new NetworkError(
      `OAuth token request failed: ${detail}`,
      'oauth',
      err instanceof Error ? err : undefined,
      meta.code,
      meta.syscall,
      meta.hostname,
    )
  }

  if (!response.ok) {
    let detail = response.statusText
    try {
      const err = (await response.json()) as Record<string, unknown>
      if (typeof err.error_description === 'string') detail = err.error_description
    } catch {
      // non-JSON error body (reverse-proxy HTML etc.)
    }
    throw new Error(`OAuth token acquisition failed (${response.status}): ${detail}`)
  }

  const json = (await response.json()) as Record<string, unknown>
  if (typeof json.access_token !== 'string' || typeof json.expires_at !== 'number') {
    throw new Error('Invalid OAuth response: missing access_token or expires_at')
  }
  return json as unknown as OAuthTokenResponse
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
}

export interface WsClientOptions {
  ca?: Buffer
  tlsVerify?: boolean
  // Optional reconnect adapter. When sendRequest sees errorCode=203
  // CREDENTIALS_EXPIRED it calls back here to drive a full close → fresh-token
  // reconnect, then retries the original request once. Without an adapter
  // wired, the 203 response surfaces to the caller as-is.
  forceReconnect?: (reason: string) => Promise<void>
}

export class WsClient {
  private ws: WebSocket | null = null
  private idCounter = new IdCounter()
  private matcher = new RequestMatcher()
  // Per-fileId listener for uploadFileProgress notifications pushed by the
  // server after subscribeFileProgress. Cleared on WS close.
  private progressHandlers = new Map<string, (progress: number) => void>()

  public botUserId: string | null = null
  public onInboundMessage: ((msg: TrueConfRequest) => void | Promise<void>) | null = null
  public onClose: ((code: number, reason: string) => void) | null = null
  public onPong: (() => void) | null = null
  public logger: Logger | null = null
  // Custom CA bundle for WebSocket TLS (downloaded by the setup wizard and
  // written to caPath). Passed straight through to ws's `ca` option.
  public ca: Buffer | undefined = undefined
  // When false, the WebSocket handshake skips cert verification — the
  // operator-acknowledged insecure mode for self-signed TrueConf Servers.
  // Defaults to true so any code path that forgets to thread the flag stays
  // safe-by-default.
  public tlsVerify = true

  private pushListeners: Array<(method: string, payload: Record<string, unknown>) => void> = []
  private authListeners: Array<() => void> = []
  private readonly forceReconnect?: (reason: string) => Promise<void>

  // Awaitable barrier between connect-start and auth-success. sendRequest
  // gates on this so callers can fire requests during a reconnect window
  // and have them automatically queue until the next auth completes.
  private authBarrier: Deferred = this.makeDeferred()

  constructor(options?: WsClientOptions) {
    if (options?.ca) this.ca = options.ca
    if (options?.tlsVerify === false) this.tlsVerify = false
    this.forceReconnect = options?.forceReconnect
  }

  // Returns the option bag passed to `new WebSocket(..., options)`. When
  // tlsVerify=false, the insecure flag wins over a stale ca pin so the
  // outcome is unambiguous. When neither knob is set, returns undefined so
  // ws falls back to the system trust store (default behavior).
  buildClientOptions(): { rejectUnauthorized: false } | { ca: Buffer } | undefined {
    if (this.tlsVerify === false) return { rejectUnauthorized: false }
    if (this.ca) return { ca: this.ca }
    return undefined
  }

  onFileProgress(fileId: string, handler: (progress: number) => void): void {
    this.progressHandlers.set(fileId, handler)
  }

  offFileProgress(fileId: string): void {
    this.progressHandlers.delete(fileId)
  }

  onPush(listener: (method: string, payload: Record<string, unknown>) => void): () => void {
    this.pushListeners.push(listener)
    return () => {
      this.pushListeners = this.pushListeners.filter((l) => l !== listener)
    }
  }

  onAuth(listener: () => void): () => void {
    this.authListeners.push(listener)
    return () => {
      this.authListeners = this.authListeners.filter((l) => l !== listener)
    }
  }

  private makeDeferred(): Deferred {
    let resolve!: () => void
    let reject!: (err: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Pre-attach a no-op catch so a barrier rejected before anyone called
    // waitAuthenticated() does not surface as an unhandled-rejection warning.
    promise.catch(() => undefined)
    return { promise, resolve, reject }
  }

  // resetAuthBarrier MUST reject the previous deferred before swapping so any
  // pending waitAuthenticated() callers fail fast instead of hanging until
  // their per-call timeout. Otherwise concurrent senders can hold a
  // resolved-old reference past close().
  resetAuthBarrier(reason: string = 'reset'): void {
    const old = this.authBarrier
    this.authBarrier = this.makeDeferred()
    old.reject(new Error(`auth barrier reset: ${reason}`))
  }

  markAuthenticated(): void {
    this.authBarrier.resolve()
  }

  markAuthFailed(err: Error): void {
    this.authBarrier.reject(err)
  }

  async waitAuthenticated(timeoutMs = 30_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.authBarrier.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`waitAuthenticated timed out after ${timeoutMs}ms`))
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  connect(config: TrueConfAccountConfig, token: string): Promise<void> {
    this.matcher.rejectAll(new Error('New connection started'))
    this.progressHandlers.clear()
    this.idCounter.reset()
    const ws = new WebSocket(
      buildWsUrl(config),
      'json.v1',
      this.buildClientOptions(),
    )
    this.ws = ws

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }

      ws.on('open', () => {
        const authId = this.idCounter.next()
        const authPromise = this.matcher.track(authId)
        ws.send(JSON.stringify(buildAuthRequest(authId, token)))
        authPromise
          .then((response: TrueConfResponse) => {
            const errorCode = response.payload?.errorCode
            if (errorCode !== undefined && errorCode !== 0) {
              const desc = response.payload?.errorDescription ?? ''
              settle(() => reject(new Error(`Auth failed: errorCode ${errorCode}${desc ? ' - ' + desc : ''}`)))
            } else {
              this.botUserId = (response.payload?.userId as string) ?? null
              for (const l of this.authListeners) {
                try { l() }
                catch (err) {
                  this.logger?.error(
                    `[trueconf] auth listener error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
                  )
                }
              }
              settle(() => resolve())
            }
          })
          .catch((err: Error) => settle(() => reject(err)))
      })

      // Auto-ack and inbound dispatch close over the LOCAL `ws` reference so a
      // mid-frame reconnect that reassigns `this.ws` cannot misroute the ack
      // (or push) to the new socket. This mirrors python-trueconf-bot's
      // per-connection task model.
      ws.on('message', (data: Buffer | string) => {
        let msg: { type?: number; id?: number; method?: string; payload?: unknown }
        try {
          msg = JSON.parse(data.toString()) as typeof msg
        } catch (err) {
          this.logger?.warn(
            `[trueconf] Malformed JSON in message handler: ${err instanceof Error ? err.message : String(err)}`,
          )
          return
        }

        // Auto-ack every server-originated request so we never miss the
        // protocol's mandatory reply. Use the captured ws (not this.ws) and
        // skip if the socket already closed underneath us.
        if (msg?.type === 1 && typeof msg.id === 'number') {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 2, id: msg.id }))
            } catch (err) {
              this.logger?.warn(
                `[trueconf] auto-ack failed: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
        }

        if (msg?.type === 2 && typeof msg.id === 'number') {
          this.matcher.resolve(msg.id, msg as TrueConfResponse)
          return
        }

        if (msg?.type === 1) {
          // Docs name the event `uploadingProgress` but the server actually
          // sends `uploadFileProgress`. Route it to the registered
          // per-fileId handler and don't forward to onInboundMessage.
          if (msg.method === 'uploadFileProgress') {
            const payload = (msg.payload ?? {}) as { fileId?: unknown; progress?: unknown }
            const fileId = payload.fileId
            const progress = payload.progress
            if (typeof fileId === 'string' && typeof progress === 'number') {
              this.progressHandlers.get(fileId)?.(progress)
            }
            return
          }
          // sendMessage is delivered via onInboundMessage only — push
          // listeners are for non-message events (chat lifecycle, member role
          // changes, presence, etc.). Mirrors python-trueconf-bot routing.
          if (msg.method !== 'sendMessage') {
            for (const l of this.pushListeners) {
              try { l(msg.method!, (msg.payload ?? {}) as Record<string, unknown>) }
              catch (err) {
                this.logger?.error(
                  `[trueconf] push listener error for method=${msg.method}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
                )
              }
            }
          }
          if (this.onInboundMessage) this.onInboundMessage(msg as TrueConfRequest)
        }
      })

      ws.on('error', (err: Error) => {
        const code = 'code' in err ? String((err as { code: unknown }).code) : undefined
        const syscall = 'syscall' in err ? String((err as { syscall: unknown }).syscall) : undefined
        const hostname = 'hostname' in err ? String((err as { hostname: unknown }).hostname) : undefined
        settle(() => reject(new NetworkError(
          `WebSocket error: ${err.message}`,
          'websocket',
          err,
          code,
          syscall,
          hostname,
        )))
      })
      ws.on('close', (code: number, reason: Buffer) => {
        // Stale close from an old socket (e.g., a delayed close event arriving
        // after a forced reconnect already swapped this.ws to a new socket).
        // Ignoring is correct: rejecting matcher pendings or clearing progress
        // handlers would clobber the new socket's in-flight state, and bubbling
        // up to lifecycle.handleClose would schedule a redundant reconnect.
        if (this.ws !== ws) {
          this.logger?.info(`[trueconf] stale close from old socket (code=${code}); ignoring`)
          return
        }
        this.matcher.rejectAll(new Error('WebSocket closed: ' + code + ' ' + (reason?.toString() ?? '')))
        this.progressHandlers.clear()
        this.onClose?.(code, reason?.toString() ?? '')
      })
      ws.on('pong', () => this.onPong?.())
    })
  }

  // Public sendRequest gates on the auth barrier (so requests fired during a
  // reconnect window queue until auth lands) and recovers from
  // CREDENTIALS_EXPIRED (203) by forcing a fresh-token reconnect once.
  async sendRequest(method: string, payload: Record<string, unknown>): Promise<TrueConfResponse> {
    await this.waitAuthenticated()
    const response = await this.sendRequestInternal(method, payload)

    if (response.payload?.errorCode === ErrorCode.CREDENTIALS_EXPIRED) {
      this.logger?.warn(
        `[trueconf] ${method} returned 203 CREDENTIALS_EXPIRED; forcing reconnect with fresh token`,
      )
      if (!this.forceReconnect) {
        // Fail-soft: surface the 203 instead of hanging forever. ConnectionLifecycle
        // is the only entity allowed to drive reconnects; if it never wired the
        // callback there is nothing safe we can do here.
        this.logger?.error(
          '[trueconf] 203 received but no forceReconnect callback wired; surfacing original response',
        )
        return response
      }
      await this.forceReconnect('203_credentials_expired')
      await this.waitAuthenticated()
      return this.sendRequestInternal(method, payload)
    }

    return response
  }

  private sendRequestInternal(method: string, payload: Record<string, unknown>): Promise<TrueConfResponse> {
    const id = this.idCounter.next()
    const request: TrueConfRequest = { type: 1, id, method, payload }
    const tracked = this.matcher.track(id)
    try {
      this.send(request)
    } catch (err) {
      this.matcher.reject(id, err instanceof Error ? err : new Error(String(err)))
    }
    return tracked
  }

  send(msg: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected')
    }
    this.ws.send(JSON.stringify(msg))
  }

  close(): void {
    this.ws?.close(1000, 'Client closing')
  }

  ping(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping()
  }

  terminate(): void {
    this.ws?.terminate()
  }
}

interface LifecycleOptions {
  onConnectionClosed?: (code: number, reason: string) => void
  onConnected?: () => void
  onDisconnected?: () => void
}

// Liveness is governed by WebSocket protocol ping/pong (opcode 0x9/0xA) on a
// 30s/10s schedule, mirroring python-trueconf-bot's websockets.connect
// configuration. Pong timeout escalates via terminate() so the normal
// close → scheduleReconnect path runs.
export class ConnectionLifecycle {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private lastPingAt = 0
  private lastPongAt = 0
  private backoffMs = 1000
  private shuttingDown = false
  private reconnecting = false
  private dnsRetryCount = 0
  private reconnectInflight: Promise<void> | null = null
  private suppressNextCloseReconnect = false
  private static readonly DNS_MAX_RETRIES = 5

  constructor(
    private wsClient: WsClient,
    private config: TrueConfAccountConfig,
    private logger: Logger,
    private options?: LifecycleOptions & { dispatcher?: Dispatcher },
  ) {}

  async start(): Promise<void> {
    // Re-arm the auth barrier at the top of every start() so requests issued
    // during the reconnect window queue on the new attempt rather than seeing
    // the stale resolved promise from the previous session.
    this.wsClient.resetAuthBarrier('lifecycle.start')
    let tokenResponse: OAuthTokenResponse
    try {
      tokenResponse = await acquireToken(this.config, { dispatcher: this.options?.dispatcher })
    } catch (err) {
      this.wsClient.markAuthFailed(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
    // Register lifecycle handlers BEFORE connect so a close event that fires
    // between auth completion and the first post-connect line still routes
    // through handleClose → scheduleReconnect.
    this.wsClient.onClose = (code, reason) => this.handleClose(code, reason)
    this.wsClient.onPong = () => { this.lastPongAt = Date.now() }
    try {
      await this.wsClient.connect(this.config, tokenResponse.access_token)
    } catch (err) {
      this.wsClient.markAuthFailed(err instanceof Error ? err : new Error(String(err)))
      throw err
    }

    this.backoffMs = 1000
    this.reconnecting = false
    this.dnsRetryCount = 0
    this.wsClient.markAuthenticated()
    this.logger.info('[trueconf] Connected and authenticated')
    try {
      this.options?.onConnected?.()
    } catch (err) {
      this.logger.warn(`[trueconf] onConnected callback failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    this.startTimers(tokenResponse.expires_at)
  }

  shutdown(): void {
    this.logger.info('[trueconf] Shutting down connection')
    this.shuttingDown = true
    // Reject the auth barrier with an explicit reason so any pending
    // waitAuthenticated() callers fail fast on shutdown instead of waiting
    // out their per-call timeout.
    this.wsClient.markAuthFailed(new Error('lifecycle shutting down'))
    this.stopTimers()
    this.cancelReconnect()
    this.wsClient.close()
  }

  // forceReconnect tears down the current connection and brings up a fresh
  // one, used when sendRequest sees CREDENTIALS_EXPIRED (203). Sequencing is
  // load-bearing: SYNC barrier-reject → SYNC suppress flag → SYNC cancel
  // pending retry timer → close (async). The suppress flag prevents the
  // close handler from racing us with its own scheduleReconnect.
  async forceReconnect(reason: string): Promise<void> {
    if (this.reconnectInflight) return this.reconnectInflight
    this.logger.info(`[trueconf] Forced reconnect: ${reason}`)

    this.wsClient.resetAuthBarrier(`forced reconnect: ${reason}`)
    this.suppressNextCloseReconnect = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.wsClient.close()

    this.reconnectInflight = (async () => {
      try {
        await this.start()
      } finally {
        this.reconnectInflight = null
        this.suppressNextCloseReconnect = false
      }
    })()
    return this.reconnectInflight
  }

  private startTimers(expiresAt: number): void {
    this.stopTimers()
    const now = Date.now()
    this.lastPingAt = now
    this.lastPongAt = now
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_INTERVAL_MS)

    const delayMs = (expiresAt - 3600) * 1000 - Date.now()
    if (delayMs <= 0) {
      this.refreshAndReconnect()
      return
    }
    this.tokenRefreshTimer = setTimeout(() => this.refreshAndReconnect(), Math.min(delayMs, 2_147_483_647))
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.tokenRefreshTimer) { clearTimeout(this.tokenRefreshTimer); this.tokenRefreshTimer = null }
  }

  private handleClose(code: number, reason: string): void {
    this.stopTimers()
    try {
      this.options?.onDisconnected?.()
    } catch (err) {
      this.logger.warn(`[trueconf] onDisconnected callback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (this.shuttingDown || this.reconnecting) return
    if (this.suppressNextCloseReconnect) {
      // forceReconnect owns the next start() — do not race it with our own
      // scheduleReconnect. One-shot: cleared by the inflight finally block.
      this.suppressNextCloseReconnect = false
      return
    }
    this.logger.info(`[trueconf] Connection closed (code: ${code}, reason: "${reason}"), scheduling reconnect`)
    try {
      this.options?.onConnectionClosed?.(code, reason)
    } catch (err) {
      this.logger.warn(`[trueconf] onConnectionClosed callback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.reconnecting = true
    this.scheduleReconnect()
  }

  private heartbeatTick(): void {
    if (this.lastPingAt - this.lastPongAt > HEARTBEAT_PONG_TIMEOUT_MS) {
      this.logger.warn('[trueconf] Heartbeat pong timeout, terminating socket')
      this.escalateDeadConnection('heartbeat pong timeout')
      return
    }
    try {
      this.wsClient.ping()
      this.lastPingAt = Date.now()
    } catch (err) {
      this.logger.warn(`[trueconf] Heartbeat ping threw: ${err instanceof Error ? err.message : String(err)}`)
      this.escalateDeadConnection('heartbeat ping throw')
    }
  }

  private escalateDeadConnection(cause: string): void {
    this.logger.warn(`[trueconf] Terminating dead connection (${cause})`)
    this.wsClient.terminate()
  }

  private isDnsError(err: unknown): boolean {
    return err instanceof NetworkError && typeof err.code === 'string' && DNS_ERROR_CODES.has(err.code)
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.start()
        this.dnsRetryCount = 0
      } catch (err) {
        this.logger.warn(`[trueconf] Reconnect attempt failed: ${err instanceof Error ? err.message : String(err)}`)
        if (this.isDnsError(err)) {
          this.dnsRetryCount++
          if (this.dnsRetryCount >= ConnectionLifecycle.DNS_MAX_RETRIES) {
            this.logger.error(
              `[trueconf] DNS resolve failed ${this.dnsRetryCount} times; check serverUrl. Giving up.`,
            )
            try { this.options?.onConnectionClosed?.(0, 'dns_unreachable') } catch { /* swallow */ }
            // Reject the auth barrier so pending senders see the actionable
            // dns_unreachable reason immediately instead of timing out silently.
            // Use DNS_TERMINAL_CODE (paired with the transient DNS_ERROR_CODES
            // set in types.ts) so consumers branching on `err instanceof
            // NetworkError` can distinguish a terminal DNS failure from a
            // retryable one without spinning further.
            this.wsClient.markAuthFailed(
              new NetworkError(
                `dns_unreachable: gave up after ${this.dnsRetryCount} retries`,
                'websocket',
                undefined,
                DNS_TERMINAL_CODE,
              ),
            )
            this.wsClient.close()
            return
          }
        }
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
        this.scheduleReconnect()
      }
    }, this.backoffMs + Math.random() * 1000)
    this.reconnectTimer.unref?.()
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.reconnecting = false
  }

  // ws library dispatches close events async; handleClose() sees
  // shuttingDown=false and fires scheduleReconnect → start() with a fresh token.
  private refreshAndReconnect(): void {
    this.wsClient.close()
  }
}
