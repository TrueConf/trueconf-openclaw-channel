import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket as WsServerSocket } from 'ws'
import { acquireToken, WsClient, ConnectionLifecycle } from '../../src/ws-client'
import { NetworkError, type Logger, type TrueConfAccountConfig } from '../../src/types'

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, fetch: vi.fn(actual.fetch) }
})

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('WsClient TLS options', () => {
  it('defaults tlsVerify to true (system trust)', () => {
    const ws = new WsClient()
    expect(ws.tlsVerify).toBe(true)
  })

  it('accepts tlsVerify=false and exposes it on the instance', () => {
    const ws = new WsClient({ tlsVerify: false })
    expect(ws.tlsVerify).toBe(false)
  })

  it('builds ws ClientOptions with rejectUnauthorized=false when tlsVerify=false', () => {
    const ws = new WsClient({ tlsVerify: false })
    expect(ws.buildClientOptions()).toEqual({ rejectUnauthorized: false })
  })

  it('builds ws ClientOptions with ca buffer when ca is set and tlsVerify is true', () => {
    const ca = Buffer.from('-----BEGIN CERTIFICATE-----\nMIIBAA==\n-----END CERTIFICATE-----\n', 'utf8')
    const ws = new WsClient({ ca })
    expect(ws.buildClientOptions()).toEqual({ ca })
  })

  it('returns undefined ClientOptions when neither ca nor tlsVerify=false is set', () => {
    const ws = new WsClient()
    expect(ws.buildClientOptions()).toBeUndefined()
  })

  it('prefers rejectUnauthorized=false over ca when both set (insecure mode wins)', () => {
    // Defensive: caller shouldn't pass both, but if they do the spec wants the
    // explicit insecure-mode flag to win — pinning a CA while skipping
    // verification is contradictory, and rejectUnauthorized:false makes the
    // outcome unambiguous (no verification at all).
    const ca = Buffer.from('-----BEGIN CERTIFICATE-----\nMIIBAA==\n-----END CERTIFICATE-----\n', 'utf8')
    const ws = new WsClient({ ca, tlsVerify: false })
    expect(ws.buildClientOptions()).toEqual({ rejectUnauthorized: false })
  })
})

describe('acquireToken', () => {
  it('includes undici fetch cause in startup OAuth errors', async () => {
    vi.mocked(undiciFetch).mockImplementationOnce(async () => {
      const cause = new Error('unable to verify the first certificate') as Error & { code: string }
      cause.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      throw new TypeError('fetch failed', { cause })
    })
    await expect(acquireToken({
      serverUrl: 'tc.example.com',
      username: 'bot',
      password: 'secret',
      useTls: true,
      port: 443,
    })).rejects.toThrow(/fetch failed.*UNABLE_TO_VERIFY_LEAF_SIGNATURE.*unable to verify the first certificate/)
  })

  it('wraps fetch errors as NetworkError(phase="oauth") with preserved code/syscall/hostname', async () => {
    vi.mocked(undiciFetch).mockImplementationOnce(async () => {
      const cause = new Error('getaddrinfo ENOTFOUND missing.example.com') as Error & {
        code: string; syscall: string; hostname: string
      }
      cause.code = 'ENOTFOUND'
      cause.syscall = 'getaddrinfo'
      cause.hostname = 'missing.example.com'
      throw new TypeError('fetch failed', { cause })
    })
    let caught: unknown = null
    try {
      await acquireToken({
        serverUrl: 'missing.example.com',
        username: 'bot',
        password: 'secret',
        useTls: true,
        port: 443,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NetworkError)
    const ne = caught as NetworkError
    expect(ne.phase).toBe('oauth')
    expect(ne.code).toBe('ENOTFOUND')
    expect(ne.syscall).toBe('getaddrinfo')
    expect(ne.hostname).toBe('missing.example.com')
  })
})

// Integration helper: a tiny in-process plaintext WS server that speaks the
// minimal TrueConf chatbot dialect we need to drive the client through real
// open/auth/recv/close paths.
interface FakeWsServer {
  port: number
  close: () => Promise<void>
  // Hooks for individual tests.
  onAuth: (handler: (id: number, ws: WsServerSocket) => void) => void
  onRequest: (handler: (msg: { id: number; method: string; payload?: unknown }, ws: WsServerSocket) => void) => void
  // Push something from server to client (type=1 frame) on the active socket.
  pushToActive: (msg: object) => void
  // Force-close the active client connection (server side) without an error.
  closeActive: () => void
  // Force a TCP-level termination on the active client connection. Mirrors a
  // proxy/server-side reset: client sees ws code=1006 with no close-frame.
  terminateActive: () => void
  // Number of acks received on the wire (auto-ack assertions).
  acksSeen: () => Array<number>
  // Most-recently connected socket reference (for assertions on which socket was acked).
  activeSocket: () => WsServerSocket | null
  // How many WS connections have been accepted lifetime — for reconnect assertions.
  connectionCount: () => number
}

async function startFakeWsServer(): Promise<FakeWsServer> {
  const acks: number[] = []
  let activeSocket: WsServerSocket | null = null
  let connectionCount = 0
  let onAuth: (id: number, ws: WsServerSocket) => void = (id, ws) => {
    ws.send(JSON.stringify({ type: 2, id, payload: { errorCode: 0, userId: 'bot@example.com' } }))
  }
  let onRequest: (msg: { id: number; method: string; payload?: unknown }, ws: WsServerSocket) => void = () => {}

  const http = createServer()
  // Minimal OAuth endpoint so ConnectionLifecycle.start() can complete its
  // acquireToken step without hitting the real TrueConf bridge.
  http.on('request', (req, res) => {
    if (req.url === '/bridge/api/client/v1/oauth/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk.toString() })
      req.on('end', () => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          access_token: 'fake-token',
          expires_at: Math.floor(Date.now() / 1000) + 7200,
        }))
      })
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  const wss = new WebSocketServer({
    server: http,
    path: '/websocket/chat_bot/',
    handleProtocols: (protocols) => (protocols.has('json.v1') ? 'json.v1' : false),
  })

  wss.on('connection', (ws) => {
    activeSocket = ws
    connectionCount++
    ws.on('message', (data) => {
      let msg: { type?: number; id?: number; method?: string; payload?: unknown }
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.type === 2 && typeof msg.id === 'number') {
        acks.push(msg.id)
        return
      }
      if (msg.type === 1 && msg.method === 'auth' && typeof msg.id === 'number') {
        onAuth(msg.id, ws)
        return
      }
      if (msg.type === 1 && typeof msg.id === 'number' && typeof msg.method === 'string') {
        onRequest({ id: msg.id, method: msg.method, payload: msg.payload }, ws)
      }
    })
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()))
  const port = (http.address() as AddressInfo).port

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
    onAuth: (h) => { onAuth = h },
    onRequest: (h) => { onRequest = h },
    pushToActive: (msg) => { if (activeSocket && activeSocket.readyState === WsServerSocket.OPEN) activeSocket.send(JSON.stringify(msg)) },
    closeActive: () => { if (activeSocket) activeSocket.close() },
    terminateActive: () => { if (activeSocket) activeSocket.terminate() },
    acksSeen: () => [...acks],
    activeSocket: () => activeSocket,
    connectionCount: () => connectionCount,
  }
}

function makeConfig(port: number): TrueConfAccountConfig {
  return {
    serverUrl: '127.0.0.1',
    username: 'bot@example.com',
    password: 'secret',
    useTls: false,
    port,
  }
}

describe('WsClient connect — typed errors', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
  })

  it('connect ws.on("error") wraps to NetworkError(phase="websocket") with preserved code', async () => {
    // Server that accepts the TCP connection but immediately closes the socket
    // so the WebSocket handshake fails with an Error (not a clean close).
    server = createServer()
    server.on('connection', (sock) => sock.destroy())
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port

    const client = new WsClient()
    let caught: unknown = null
    try {
      await client.connect(makeConfig(port), 'fake-token')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NetworkError)
    const ne = caught as NetworkError
    expect(ne.phase).toBe('websocket')
    // The exact code depends on platform/libuv timing — accept either an empty
    // code or a known transient marker, but the wrapper itself is what we test.
    expect(typeof (ne.code ?? '')).toBe('string')
  })
})

describe('WsClient.waitAuthenticated', () => {
  it('rejects on a 100ms timeout when auth never completes', async () => {
    const client = new WsClient()
    await expect(client.waitAuthenticated(100)).rejects.toThrow(/timed out after 100ms/)
  })

  it('resolves once markAuthenticated is called', async () => {
    const client = new WsClient()
    queueMicrotask(() => client.markAuthenticated())
    await expect(client.waitAuthenticated(1000)).resolves.toBeUndefined()
  })

  it('rejects when markAuthFailed is called before auth completes', async () => {
    const client = new WsClient()
    queueMicrotask(() => client.markAuthFailed(new Error('socket closed before auth')))
    await expect(client.waitAuthenticated(1000)).rejects.toThrow(/socket closed before auth/)
  })

  it('resetAuthBarrier rejects pending waiters then re-arms a fresh barrier', async () => {
    const client = new WsClient()
    const first = client.waitAuthenticated(1000)
    client.resetAuthBarrier('reconnect')
    await expect(first).rejects.toThrow(/auth barrier reset: reconnect/)

    const second = client.waitAuthenticated(1000)
    client.markAuthenticated()
    await expect(second).resolves.toBeUndefined()
  })
})

describe('WsClient.sendRequest — 203 recovery', () => {
  it('auto-recovers on errorCode=203: forces reconnect, retries once with fresh token', async () => {
    const forceReconnect = vi.fn(async (_reason: string) => {})
    const client = new WsClient({ forceReconnect })
    client.markAuthenticated()

    // Stub sendRequestInternal to return a 203 the first time, success the second.
    const internal = vi.spyOn(client as unknown as { sendRequestInternal: (m: string, p: Record<string, unknown>) => Promise<{ type: 2; id: number; payload?: Record<string, unknown> }> }, 'sendRequestInternal')
      .mockResolvedValueOnce({ type: 2, id: 1, payload: { errorCode: 203 } })
      .mockResolvedValueOnce({ type: 2, id: 2, payload: { errorCode: 0 } })

    // After forceReconnect we must re-arm the auth barrier so the second
    // waitAuthenticated() resolves. Real ConnectionLifecycle.start() does this;
    // here we simulate it inside the stubbed callback.
    forceReconnect.mockImplementationOnce(async () => {
      client.resetAuthBarrier('forced reconnect')
      client.markAuthenticated()
    })

    const resp = await client.sendRequest('sendMessage', { chatId: 'c', content: { text: 't', parseMode: 'markdown' } })
    expect(resp.payload?.errorCode).toBe(0)
    expect(forceReconnect).toHaveBeenCalledTimes(1)
    expect(forceReconnect).toHaveBeenCalledWith('203_credentials_expired')
    expect(internal).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry on second consecutive 203 — surfaces the error', async () => {
    const forceReconnect = vi.fn(async (_reason: string) => {})
    const client = new WsClient({ forceReconnect })
    client.markAuthenticated()

    forceReconnect.mockImplementation(async () => {
      client.resetAuthBarrier('forced reconnect')
      client.markAuthenticated()
    })
    const internal = vi.spyOn(client as unknown as { sendRequestInternal: (m: string, p: Record<string, unknown>) => Promise<{ type: 2; id: number; payload?: Record<string, unknown> }> }, 'sendRequestInternal')
      .mockResolvedValue({ type: 2, id: 1, payload: { errorCode: 203 } })

    const resp = await client.sendRequest('sendMessage', { chatId: 'c', content: { text: 't', parseMode: 'markdown' } })
    expect(resp.payload?.errorCode).toBe(203)
    expect(forceReconnect).toHaveBeenCalledTimes(1)
    expect(internal).toHaveBeenCalledTimes(2)
  })

  it('fails soft if 203 received but no forceReconnect callback is wired', async () => {
    const client = new WsClient()
    client.markAuthenticated()
    vi.spyOn(client as unknown as { sendRequestInternal: (m: string, p: Record<string, unknown>) => Promise<{ type: 2; id: number; payload?: Record<string, unknown> }> }, 'sendRequestInternal')
      .mockResolvedValueOnce({ type: 2, id: 1, payload: { errorCode: 203 } })

    const resp = await client.sendRequest('sendMessage', { chatId: 'c', content: { text: 't', parseMode: 'markdown' } })
    // Surfaces the original 203 instead of hanging.
    expect(resp.payload?.errorCode).toBe(203)
  })
})

describe('WsClient — message handling on captured ws', () => {
  let server: FakeWsServer | null = null

  beforeEach(async () => {
    server = await startFakeWsServer()
  })

  afterEach(async () => {
    if (server) await server.close()
    server = null
  })

  it('auto-ack is sent on the same ws that delivered the type=1 frame, not this.ws', async () => {
    const client = new WsClient()
    client.logger = silentLogger
    await client.connect(makeConfig(server!.port), 'fake-token')

    // Simulate a mid-frame reconnect race: the original socket is still open
    // and a server-pushed type=1 is about to arrive on it, but `this.ws` has
    // already been swapped to point at a different (newer) socket. The auto-
    // ack must close over the captured `ws` and reply on the ORIGINAL socket,
    // not on `this.ws`. If the implementation regresses to `this.ws.send(...)`,
    // the ack would land on the decoy and never reach the test server.
    const wsRef = client as unknown as { ws: unknown }
    const original = wsRef.ws
    const decoySend = vi.fn()
    const decoy = { readyState: 1 /* WebSocket.OPEN */, send: decoySend }
    wsRef.ws = decoy

    const before = server!.acksSeen().length
    server!.pushToActive({ type: 1, id: 4242, method: 'somePushMethod', payload: { foo: 'bar' } })

    // Wait briefly for the ack to land.
    await new Promise<void>((r) => setTimeout(r, 50))

    // Ack flowed over the ORIGINAL socket → server saw it.
    const after = server!.acksSeen()
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1]).toBe(4242)
    // And it did NOT go through the swapped `this.ws` reference.
    expect(decoySend).not.toHaveBeenCalled()

    // Restore the real ws so client.close() shuts the original socket and
    // afterEach can tear the fake server down without hanging.
    wsRef.ws = original
    client.close()
  })

  it('stale close from an old socket (after this.ws swap) does NOT reject pendings, clear progress, or fire onClose', async () => {
    const client = new WsClient()
    client.logger = silentLogger
    await client.connect(makeConfig(server!.port), 'fake-token')

    const onCloseSpy = vi.fn()
    client.onClose = onCloseSpy

    // Track a pending request on the matcher so we can detect a spurious
    // rejectAll that would otherwise be silent. Use a fresh id from the
    // counter to mimic a real in-flight sendRequest that hasn't returned yet.
    const matcher = (client as unknown as { matcher: { track: (id: number) => Promise<unknown> } }).matcher
    const pending = matcher.track(99999)
    let pendingRejected: Error | null = null
    pending.catch((err: Error) => { pendingRejected = err })

    // Register a progress handler so we can detect a spurious clear().
    client.onFileProgress('file-X', () => {})
    const progressHandlers = (client as unknown as { progressHandlers: Map<string, unknown> }).progressHandlers
    expect(progressHandlers.has('file-X')).toBe(true)

    // Simulate the race: forceReconnect already swapped this.ws to a new
    // socket (decoy stands in for ws_B), but the OLD socket's delayed close
    // event is about to fire. The captured-ws guard must noop on this path.
    const wsRef = client as unknown as { ws: unknown }
    const original = wsRef.ws as { close: (code?: number, reason?: string) => void; emit: (event: string, ...args: unknown[]) => void }
    const decoy = { readyState: 1 /* WebSocket.OPEN */, send: vi.fn() }
    wsRef.ws = decoy

    // Fire the old socket's 'close' event directly so the registered listener
    // runs synchronously. ws's EventEmitter delivers to all listeners — the
    // one we care about is the connect()-scope handler with the captured ws.
    original.emit('close', 1006, Buffer.from('test stale'))

    // Yield once so any spurious microtask-scheduled rejection lands.
    await new Promise<void>((r) => setTimeout(r, 20))

    // Guard's three contracts:
    //  - matcher.rejectAll NOT called (pending request still alive).
    //  - progressHandlers NOT cleared.
    //  - onClose NOT invoked (lifecycle.handleClose would otherwise schedule
    //    a redundant reconnect that closes ws_B).
    expect(pendingRejected).toBeNull()
    expect(progressHandlers.has('file-X')).toBe(true)
    expect(onCloseSpy).not.toHaveBeenCalled()

    // Restore the real ws so client.close() shuts the original socket and
    // afterEach can tear the fake server down without hanging.
    wsRef.ws = original
    client.close()
  })

  it('close() forwards the close event to onClose so lifecycle can schedule reconnect', async () => {
    const client = new WsClient()
    client.logger = silentLogger
    await client.connect(makeConfig(server!.port), 'fake-token')

    const onCloseSpy = vi.fn()
    client.onClose = onCloseSpy

    client.close()

    // ws emits 'close' on the next event-loop tick after the TCP FIN handshake;
    // 50 ms is generous slack for CI. Do NOT shrink to 0 — close is async.
    await new Promise<void>((r) => setTimeout(r, 50))

    // Contract under test: close() must NOT suppress its own close event.
    // Lifecycle.handleClose subscribes via onClose and is the only entity that
    // schedules a reconnect — if onClose never fires, the bot goes silent.
    expect(onCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('terminate() forwards the close event to onClose so lifecycle can schedule reconnect', async () => {
    const client = new WsClient()
    client.logger = silentLogger
    await client.connect(makeConfig(server!.port), 'fake-token')

    const onCloseSpy = vi.fn()
    client.onClose = onCloseSpy

    client.terminate()

    // ws emits 'close' on the next event-loop tick after the TCP FIN handshake;
    // 50 ms is generous slack for CI. Do NOT shrink to 0 — close is async.
    await new Promise<void>((r) => setTimeout(r, 50))

    // Contract under test: terminate() (used by escalateDeadConnection on
    // heartbeat pong timeout) must NOT suppress its own close event.
    expect(onCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('sendMessage push (method="sendMessage") does NOT call onPush listeners; only onInboundMessage', async () => {
    const client = new WsClient()
    client.logger = silentLogger
    await client.connect(makeConfig(server!.port), 'fake-token')

    const pushSpy = vi.fn()
    const inboundSpy = vi.fn()
    client.onPush(pushSpy)
    client.onInboundMessage = inboundSpy

    server!.pushToActive({ type: 1, id: 1001, method: 'sendMessage', payload: { chatId: 'c', envelope: { type: 200 } } })
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(pushSpy).not.toHaveBeenCalled()
    expect(inboundSpy).toHaveBeenCalledTimes(1)

    // Sanity: a non-sendMessage push DOES go to onPush.
    server!.pushToActive({ type: 1, id: 1002, method: 'roleChanged', payload: {} })
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy).toHaveBeenCalledWith('roleChanged', {})

    client.close()
  })
})

describe('ConnectionLifecycle DNS retry policy', () => {
  it('DNS NetworkError increments retry counter; gives up after 5 attempts with onConnectionClosed(0,"dns_unreachable")', async () => {
    vi.useFakeTimers()
    try {
      const closedCb = vi.fn()
      const client = new WsClient()
      const config = { serverUrl: 'missing.example.com', username: 'bot', password: 'secret', useTls: true } satisfies TrueConfAccountConfig
      const lifecycle = new ConnectionLifecycle(client, config, silentLogger, { onConnectionClosed: closedCb })

      // Force every start() to throw a DNS NetworkError.
      const startSpy = vi.spyOn(lifecycle, 'start').mockImplementation(async () => {
        throw new NetworkError('getaddrinfo ENOTFOUND missing.example.com', 'oauth', undefined, 'ENOTFOUND', 'getaddrinfo', 'missing.example.com')
      })
      // Stub close so we don't try to interact with a real socket.
      vi.spyOn(client, 'close').mockImplementation(() => {})

      // Trigger the first scheduleReconnect by simulating handleClose.
      ;(lifecycle as unknown as { scheduleReconnect: () => void }).scheduleReconnect()

      // Drain timers up to a generous bound, allowing the chain of
      // setTimeout → start() (rejects) → setTimeout → ... to play out.
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(120_000)
      }

      expect(startSpy).toHaveBeenCalledTimes(5)
      expect(closedCb).toHaveBeenCalledWith(0, 'dns_unreachable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('DNS-giveup also rejects the auth barrier so pending senders fail fast with dns_unreachable', async () => {
    vi.useFakeTimers()
    try {
      const closedCb = vi.fn()
      const client = new WsClient()
      const config = { serverUrl: 'missing.example.com', username: 'bot', password: 'secret', useTls: true } satisfies TrueConfAccountConfig
      const lifecycle = new ConnectionLifecycle(client, config, silentLogger, { onConnectionClosed: closedCb })

      const startSpy = vi.spyOn(lifecycle, 'start').mockImplementation(async () => {
        throw new NetworkError('getaddrinfo ENOTFOUND missing.example.com', 'oauth', undefined, 'ENOTFOUND', 'getaddrinfo', 'missing.example.com')
      })
      vi.spyOn(client, 'close').mockImplementation(() => {})

      // Pending sender waiting on auth — would otherwise hang for 60s.
      const waiter = client.waitAuthenticated(60_000)
      // Pre-attach a swallow so vitest's unhandled-rejection guard doesn't
      // flag the rejection while the timer chain is still draining.
      const waiterResult = waiter.then(() => ({ ok: true as const }), (err: Error) => ({ ok: false as const, err }))

      ;(lifecycle as unknown as { scheduleReconnect: () => void }).scheduleReconnect()

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(120_000)
      }

      expect(startSpy).toHaveBeenCalledTimes(5)
      expect(closedCb).toHaveBeenCalledWith(0, 'dns_unreachable')

      const result = await waiterResult
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.err.message).toMatch(/dns_unreachable/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('non-DNS NetworkError (ECONNREFUSED) keeps retrying past 5 attempts', async () => {
    vi.useFakeTimers()
    try {
      const closedCb = vi.fn()
      const client = new WsClient()
      const config = { serverUrl: '127.0.0.1', username: 'bot', password: 'secret', useTls: false, port: 65111 } satisfies TrueConfAccountConfig
      const lifecycle = new ConnectionLifecycle(client, config, silentLogger, { onConnectionClosed: closedCb })

      const startSpy = vi.spyOn(lifecycle, 'start').mockImplementation(async () => {
        throw new NetworkError('connect ECONNREFUSED 127.0.0.1:65111', 'websocket', undefined, 'ECONNREFUSED', 'connect', '127.0.0.1')
      })
      vi.spyOn(client, 'close').mockImplementation(() => {})

      ;(lifecycle as unknown as { scheduleReconnect: () => void }).scheduleReconnect()

      // Allow enough virtual time for >5 attempts; the cap is 60_000ms so 10
      // attempts fits inside ~10 minutes of timer time.
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(120_000)
      }

      // Strictly more than 5 attempts proves the dns_unreachable bail-out did
      // not fire for ECONNREFUSED.
      expect(startSpy.mock.calls.length).toBeGreaterThan(5)
      expect(closedCb).not.toHaveBeenCalledWith(0, 'dns_unreachable')

      // Stop the chain so the test exits cleanly.
      ;(lifecycle as unknown as { cancelReconnect: () => void }).cancelReconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ConnectionLifecycle.shutdown — auth barrier', () => {
  it('rejects pending waitAuthenticated() callers fast with a shutdown reason (no per-call timeout)', async () => {
    const client = new WsClient()
    const config = { serverUrl: '127.0.0.1', username: 'bot', password: 'secret', useTls: false, port: 4309 } satisfies TrueConfAccountConfig
    const lifecycle = new ConnectionLifecycle(client, config, silentLogger)

    // Pre-arm a long-timeout waiter — without the fix this would hang for 60s.
    const pending = client.waitAuthenticated(60_000)

    // Stub close so we don't touch a real socket.
    vi.spyOn(client, 'close').mockImplementation(() => {})

    const t0 = Date.now()
    lifecycle.shutdown()
    await expect(pending).rejects.toThrow(/lifecycle shutting down/)
    // The reject must propagate within a few ms, not the 60s timeout.
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('ConnectionLifecycle.forceReconnect — race-safe sequencing', () => {
  it('rejects the old auth barrier, sets suppress flag, cancels timer, then closes', async () => {
    const client = new WsClient()
    const config = { serverUrl: '127.0.0.1', username: 'bot', password: 'secret', useTls: false, port: 4309 } satisfies TrueConfAccountConfig
    const lifecycle = new ConnectionLifecycle(client, config, silentLogger)

    // Pre-arm a pending waiter so we can confirm it rejects synchronously.
    const pending = client.waitAuthenticated(5000)
    // Replace start() so forceReconnect doesn't try to do real I/O.
    let startCalls = 0
    vi.spyOn(lifecycle, 'start').mockImplementation(async () => {
      startCalls++
    })
    const closeSpy = vi.spyOn(client, 'close').mockImplementation(() => {})

    const inflight = lifecycle.forceReconnect('203_credentials_expired')

    // The pending waiter must reject ~immediately because resetAuthBarrier
    // fires synchronously before any async work in forceReconnect.
    await expect(pending).rejects.toThrow(/auth barrier reset/)
    expect(closeSpy).toHaveBeenCalledTimes(1)

    await inflight
    expect(startCalls).toBe(1)

    // A second forceReconnect while one is in-flight is a no-op
    // (single-flight). start() is only invoked once for the whole window;
    // both callers wait on the same underlying reconnect attempt.
    let concurrentStartCalls = 0
    vi.spyOn(lifecycle, 'start').mockImplementation(async () => {
      concurrentStartCalls++
      // Stall to verify single-flight: while we're in here, the second caller
      // arrives, sees reconnectInflight !== null, and short-circuits.
      await new Promise<void>((r) => setTimeout(r, 25))
    })
    const a = lifecycle.forceReconnect('one')
    const b = lifecycle.forceReconnect('two')
    await Promise.all([a, b])
    expect(concurrentStartCalls).toBe(1)
  })
})

describe('ConnectionLifecycle.handleClose — reconnect path on 1006', () => {
  it('handleClose(1006, "") schedules reconnect that invokes start()', async () => {
    vi.useFakeTimers()
    try {
      const client = new WsClient()
      const config = { serverUrl: '127.0.0.1', username: 'bot', password: 'secret', useTls: false, port: 4309 } satisfies TrueConfAccountConfig
      const lifecycle = new ConnectionLifecycle(client, config, silentLogger)

      const startSpy = vi.spyOn(lifecycle, 'start').mockResolvedValue()

      // ws.on('close') routes the close event into onClose → lifecycle.handleClose.
      // Drive the private method directly because that's where the reconnect
      // chain begins in production.
      ;(lifecycle as unknown as { handleClose: (c: number, r: string) => void }).handleClose(1006, '')

      expect(startSpy).not.toHaveBeenCalled()

      // scheduleReconnect arms 1000–2000ms (backoffMs=1000 + jitter ≤1000).
      await vi.advanceTimersByTimeAsync(2_500)

      expect(startSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ConnectionLifecycle integration — server-side TCP-terminate triggers reconnect', () => {
  let server: FakeWsServer | null = null

  beforeEach(async () => {
    server = await startFakeWsServer()
  })

  afterEach(async () => {
    // Forcibly terminate any socket the lifecycle may have re-opened mid-
    // shutdown — otherwise server.close() awaits a still-OPEN connection and
    // the hook hits its 10s default timeout.
    if (server) {
      server.terminateActive()
      await server.close()
    }
    server = null
  }, 20_000)

  it('1006 mid-life from server.terminateActive() → handleClose → reconnect → re-auth', async () => {
    let connectedCount = 0
    let disconnectedCount = 0
    const client = new WsClient()
    client.logger = silentLogger
    const config = makeConfig(server!.port)
    const lifecycle = new ConnectionLifecycle(client, config, silentLogger, {
      onConnected: () => { connectedCount++ },
      onDisconnected: () => { disconnectedCount++ },
    })

    try {
      // First successful start() — runs real acquireToken (against fake OAuth)
      // and real client.connect() (against fake WS server).
      await lifecycle.start()
      expect(connectedCount).toBe(1)
      expect(server!.connectionCount()).toBe(1)

      // Simulate the colleague's symptom: server forcibly TCP-terminates the
      // active socket. Client receives ws code=1006 with no close-frame.
      server!.terminateActive()

      // Wait long enough for the close event to propagate AND for the initial
      // reconnect backoff (1000–2000ms with jitter) plus the re-auth round-trip
      // to complete. 4 seconds is generous but not flaky.
      await new Promise<void>((resolve) => setTimeout(resolve, 4_000))

      // Reconnect must have happened: a second connection accepted by the fake
      // server, and onConnected fired again.
      expect(server!.connectionCount()).toBe(2)
      expect(connectedCount).toBe(2)
      expect(disconnectedCount).toBeGreaterThanOrEqual(1)
    } finally {
      lifecycle.shutdown()
    }
  }, 10_000)

  it('inbound-then-terminate race: 1006 right after server-pushed message — reconnect still happens', async () => {
    // Mirrors colleague's exact reported sequence: user writes → bot reads
    // (server pushes type=1) → connection drops 1006. The race we worry about:
    // an in-flight onInboundMessage callback running concurrently with the
    // close event must not block or sabotage handleClose → scheduleReconnect.
    let connectedCount = 0
    let inboundReceived = 0
    const client = new WsClient()
    client.logger = silentLogger
    client.onInboundMessage = () => { inboundReceived++ }
    const config = makeConfig(server!.port)
    const lifecycle = new ConnectionLifecycle(client, config, silentLogger, {
      onConnected: () => { connectedCount++ },
    })

    try {
      await lifecycle.start()
      expect(connectedCount).toBe(1)

      // Push inbound and terminate in the same tick — exercises the race.
      server!.pushToActive({ type: 1, id: 9001, method: 'sendMessage', payload: { chatId: 'c', envelope: { type: 200, content: 'hi' } } })
      server!.terminateActive()

      await new Promise<void>((resolve) => setTimeout(resolve, 4_000))

      expect(inboundReceived).toBe(1)
      expect(server!.connectionCount()).toBe(2)
      expect(connectedCount).toBe(2)
    } finally {
      lifecycle.shutdown()
    }
  }, 10_000)

  it('onConnectionClosed callback throws synchronously — reconnect still proceeds', async () => {
    let connectedCount = 0
    let closedCallCount = 0
    const client = new WsClient()
    client.logger = silentLogger
    const config = makeConfig(server!.port)
    const lifecycle = new ConnectionLifecycle(client, config, silentLogger, {
      onConnected: () => { connectedCount++ },
      onConnectionClosed: () => {
        closedCallCount++
        throw new Error('synthetic sync callback failure')
      },
    })

    try {
      await lifecycle.start()
      expect(connectedCount).toBe(1)

      server!.terminateActive()
      await new Promise<void>((resolve) => setTimeout(resolve, 4_000))

      // The throw was caught by handleClose's try/catch; scheduleReconnect ran;
      // re-auth completed. If the throw escaped, reconnect would never fire.
      expect(closedCallCount).toBeGreaterThanOrEqual(1)
      expect(server!.connectionCount()).toBe(2)
      expect(connectedCount).toBe(2)
    } finally {
      lifecycle.shutdown()
    }
  }, 10_000)

  it('onConnectionClosed callback returns rejected Promise — reconnect still proceeds (no unhandledRejection break)', async () => {
    // Top suspect for the colleague's bug: handleClose calls callback without
    // await, so a returned rejected Promise becomes an unhandledRejection.
    // In OpenClaw's runtime that may surface as a process-level fault; in
    // isolation here we verify the lifecycle itself stays healthy.
    let connectedCount = 0
    let closedCallCount = 0
    const unhandledHandler = (_reason: unknown) => { /* swallow for the test window */ }
    process.on('unhandledRejection', unhandledHandler)

    const client = new WsClient()
    client.logger = silentLogger
    const config = makeConfig(server!.port)
    const lifecycle = new ConnectionLifecycle(client, config, silentLogger, {
      onConnected: () => { connectedCount++ },
      // eslint-disable-next-line @typescript-eslint/require-await
      onConnectionClosed: (() => {
        closedCallCount++
        return Promise.reject(new Error('synthetic async callback failure'))
      }) as unknown as (code: number, reason: string) => void,
    })

    try {
      await lifecycle.start()
      expect(connectedCount).toBe(1)

      server!.terminateActive()
      await new Promise<void>((resolve) => setTimeout(resolve, 4_000))

      expect(closedCallCount).toBeGreaterThanOrEqual(1)
      expect(server!.connectionCount()).toBe(2)
      expect(connectedCount).toBe(2)
    } finally {
      process.off('unhandledRejection', unhandledHandler)
      lifecycle.shutdown()
    }
  }, 10_000)

  it('three sequential server-terminates each trigger a clean reconnect (backoff resets after success)', async () => {
    let connectedCount = 0
    const client = new WsClient()
    client.logger = silentLogger
    const config = makeConfig(server!.port)
    const lifecycle = new ConnectionLifecycle(client, config, silentLogger, {
      onConnected: () => { connectedCount++ },
    })

    try {
      await lifecycle.start()
      expect(connectedCount).toBe(1)

      for (let cycle = 2; cycle <= 4; cycle++) {
        server!.terminateActive()
        // Each reconnect waits backoffMs+jitter (1000-2000ms) — successful
        // re-auth resets backoffMs to 1000, so the cycle stays bounded.
        await new Promise<void>((resolve) => setTimeout(resolve, 4_000))
        expect(connectedCount).toBe(cycle)
        expect(server!.connectionCount()).toBe(cycle)
      }
    } finally {
      lifecycle.shutdown()
    }
  }, 20_000)

})

describe('LifecycleOptions.onTerminalFailure', () => {
  const baseConfig = {
    serverUrl: 'srv.example',
    username: 'bot',
    password: 'p',
    useTls: false,
    port: 4309,
  } satisfies TrueConfAccountConfig

  it('fires onTerminalFailure when shutdown() is called', () => {
    const ws = new WsClient()
    const onTerminalFailure = vi.fn()
    const lifecycle = new ConnectionLifecycle(ws, baseConfig, silentLogger, {
      onTerminalFailure,
    })

    // Stub close so we don't try to interact with a real socket.
    vi.spyOn(ws, 'close').mockImplementation(() => {})

    lifecycle.shutdown()

    expect(onTerminalFailure).toHaveBeenCalledTimes(1)
    expect(onTerminalFailure.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(onTerminalFailure.mock.calls[0][0].message).toBe('lifecycle shutting down')
  })
})
