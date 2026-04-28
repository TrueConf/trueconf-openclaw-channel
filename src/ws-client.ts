import WebSocket from 'ws'
import { fetch, type Dispatcher, type RequestInit, type Response } from 'undici'
import { IdCounter, RequestMatcher, buildAuthRequest } from './types'
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

function describeFetchError(err: unknown): string {
  const outerMsg = err instanceof Error ? err.message : String(err)
  const cause = err instanceof Error ? err.cause : undefined
  if (!(cause instanceof Error)) return outerMsg
  const code = 'code' in cause ? String(cause.code) : ''
  return `${outerMsg} (${code ? `${code}: ` : ''}${cause.message})`
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
    throw new Error(`OAuth token request failed: ${describeFetchError(err)}`)
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

  constructor(options?: { ca?: Buffer; tlsVerify?: boolean }) {
    if (options?.ca) this.ca = options.ca
    if (options?.tlsVerify === false) this.tlsVerify = false
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

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 2) {
            this.matcher.resolve(msg.id, msg as TrueConfResponse)
          } else if (msg.type === 1) {
            // Docs name the event `uploadingProgress` but the server actually
            // sends `uploadFileProgress`. Route it to the registered
            // per-fileId handler and don't forward to onInboundMessage.
            if (msg.method === 'uploadFileProgress') {
              const fileId = msg.payload?.fileId
              const progress = msg.payload?.progress
              if (typeof fileId === 'string' && typeof progress === 'number') {
                this.progressHandlers.get(fileId)?.(progress)
              }
              return
            }
            // Notify push listeners (skip uploadFileProgress — handled above).
            for (const l of this.pushListeners) {
              try { l(msg.method, (msg.payload ?? {}) as Record<string, unknown>) }
              catch (err) {
                this.logger?.error(
                  `[trueconf] push listener error for method=${msg.method}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
                )
              }
            }
            if (this.onInboundMessage) this.onInboundMessage(msg as TrueConfRequest)
          }
        } catch (err) {
          this.logger?.warn(
            `[trueconf] Malformed JSON in message handler: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })

      ws.on('error', (err: Error) => settle(() => reject(new Error('WebSocket error: ' + err.message))))
      ws.on('close', (code: number, reason: Buffer) => {
        this.matcher.rejectAll(new Error('WebSocket closed: ' + code + ' ' + (reason?.toString() ?? '')))
        this.progressHandlers.clear()
        this.onClose?.(code, reason?.toString() ?? '')
      })
      ws.on('pong', () => this.onPong?.())
    })
  }

  sendRequest(method: string, payload: Record<string, unknown>): Promise<TrueConfResponse> {
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
    this.ws = null
  }

  ping(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping()
  }

  terminate(): void {
    if (this.ws) { this.ws.terminate(); this.ws = null }
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

  constructor(
    private wsClient: WsClient,
    private config: TrueConfAccountConfig,
    private logger: Logger,
    private options?: LifecycleOptions & { dispatcher?: Dispatcher },
  ) {}

  async start(): Promise<void> {
    const tokenResponse = await acquireToken(this.config, { dispatcher: this.options?.dispatcher })
    // Register lifecycle handlers BEFORE connect so a close event that fires
    // between auth completion and the first post-connect line still routes
    // through handleClose → scheduleReconnect.
    this.wsClient.onClose = (code, reason) => this.handleClose(code, reason)
    this.wsClient.onPong = () => { this.lastPongAt = Date.now() }
    await this.wsClient.connect(this.config, tokenResponse.access_token)

    this.backoffMs = 1000
    this.reconnecting = false
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
    this.stopTimers()
    this.cancelReconnect()
    this.wsClient.close()
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

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.start()
      } catch (err) {
        this.logger.warn(`[trueconf] Reconnect attempt failed: ${err instanceof Error ? err.message : String(err)}`)
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
        this.scheduleReconnect()
      }
    }, this.backoffMs)
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
