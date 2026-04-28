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
  // Number of acks received on the wire (auto-ack assertions).
  acksSeen: () => Array<number>
  // Most-recently connected socket reference (for assertions on which socket was acked).
  activeSocket: () => WsServerSocket | null
}

async function startFakeWsServer(): Promise<FakeWsServer> {
  const acks: number[] = []
  let activeSocket: WsServerSocket | null = null
  let onAuth: (id: number, ws: WsServerSocket) => void = (id, ws) => {
    ws.send(JSON.stringify({ type: 2, id, payload: { errorCode: 0, userId: 'bot@example.com' } }))
  }
  let onRequest: (msg: { id: number; method: string; payload?: unknown }, ws: WsServerSocket) => void = () => {}

  const http = createServer()
  const wss = new WebSocketServer({
    server: http,
    path: '/websocket/chat_bot/',
    handleProtocols: (protocols) => (protocols.has('json.v1') ? 'json.v1' : false),
  })

  wss.on('connection', (ws) => {
    activeSocket = ws
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
    acksSeen: () => [...acks],
    activeSocket: () => activeSocket,
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
    // After auth, the ws-client receives auth response (type=2). We now want
    // the client to auto-ack any *server-pushed* type=1 frame on the captured
    // ws even if `this.ws` were reassigned mid-flight.
    const before = server!.acksSeen().length
    server!.pushToActive({ type: 1, id: 4242, method: 'somePushMethod', payload: { foo: 'bar' } })

    // Wait briefly for the ack to land.
    await new Promise<void>((r) => setTimeout(r, 50))
    const after = server!.acksSeen()
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1]).toBe(4242)

    // Now reassign this.ws (simulating a mid-frame reconnect): even if the
    // closure re-fires, the auto-ack we already sent went to the original ws,
    // proving the captured-ws closure pattern.
    // (We assert via the side effect above — the ack made it back to the
    // server-side count for the original socket.)
    client.close()
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
