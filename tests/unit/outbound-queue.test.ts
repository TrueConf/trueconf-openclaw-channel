import { describe, it, expect, vi } from 'vitest'
import { OutboundQueue, type WsClientLike } from '../../src/outbound-queue'
import { NetworkError } from '../../src/types'
import type { Logger, TrueConfResponse } from '../../src/types'

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function parkable(message: string): NetworkError {
  return new NetworkError(message, 'websocket', undefined, undefined, undefined, undefined, { parkable: true })
}

interface FakeWsClient extends WsClientLike {
  sendRequest: ReturnType<typeof vi.fn<(method: string, payload: Record<string, unknown>) => Promise<TrueConfResponse>>>
  onAuth: ReturnType<typeof vi.fn<(listener: () => void) => () => void>>
  authListeners: Array<() => void>
  fireAuth: () => void
}

function makeFakeWsClient(): FakeWsClient {
  const authListeners: Array<() => void> = []
  return {
    sendRequest: vi.fn<(method: string, payload: Record<string, unknown>) => Promise<TrueConfResponse>>(),
    onAuth: vi.fn<(listener: () => void) => () => void>((listener: () => void) => {
      authListeners.push(listener)
      return () => {
        const i = authListeners.indexOf(listener)
        if (i >= 0) authListeners.splice(i, 1)
      }
    }),
    authListeners,
    fireAuth: () => { for (const l of authListeners.slice()) l() },
  }
}

describe('OutboundQueue', () => {
  it('submit → resolve on response (happy path)', async () => {
    const fake = makeFakeWsClient()
    const response: TrueConfResponse = { type: 2, id: 1, payload: { errorCode: 0 } }
    fake.sendRequest.mockResolvedValueOnce(response)

    const queue = new OutboundQueue(fake, silentLogger)
    const result = await queue.submit('sendMessage', { chatId: 'c1', text: 'hi' })

    expect(result).toEqual(response)
    expect(fake.sendRequest).toHaveBeenCalledTimes(1)
    expect(fake.sendRequest).toHaveBeenCalledWith('sendMessage', { chatId: 'c1', text: 'hi' })
  })

  it('parks on "WebSocket is not connected" — does not resolve or reject yet', async () => {
    const fake = makeFakeWsClient()
    fake.sendRequest.mockRejectedValueOnce(parkable('WebSocket is not connected'))

    const queue = new OutboundQueue(fake, silentLogger)
    let settled = false
    const promise = queue.submit('sendMessage', { chatId: 'c1' }).finally(() => { settled = true })

    await new Promise((r) => setTimeout(r, 10))

    expect(settled).toBe(false)
    expect(fake.sendRequest).toHaveBeenCalledTimes(1)
    void promise
  })

  it.each([
    ['"WebSocket closed: 1006"', parkable('WebSocket closed: 1006 ')],
    ['"auth barrier reset: forced reconnect: 203"', parkable('auth barrier reset: forced reconnect: 203_credentials_expired')],
    ['"waitAuthenticated timed out after 30000ms"', parkable('waitAuthenticated timed out after 30000ms')],
    ['"New connection started"', parkable('New connection started')],
  ])('parks on %s', async (_label, err) => {
    const fake = makeFakeWsClient()
    fake.sendRequest.mockRejectedValueOnce(err)

    const queue = new OutboundQueue(fake, silentLogger)
    let settled = false
    const promise = queue.submit('sendMessage', { chatId: 'c1' }).finally(() => { settled = true })
    await new Promise((r) => setTimeout(r, 10))

    expect(settled).toBe(false)
    void promise
  })

  it('drains parked items on auth event', async () => {
    const fake = makeFakeWsClient()
    const response: TrueConfResponse = { type: 2, id: 1, payload: { errorCode: 0 } }
    fake.sendRequest
      .mockRejectedValueOnce(parkable('WebSocket is not connected'))
      .mockResolvedValueOnce(response)

    const queue = new OutboundQueue(fake, silentLogger)
    const promise = queue.submit('sendMessage', { chatId: 'c1' })
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.sendRequest).toHaveBeenCalledTimes(1)

    fake.fireAuth()

    const result = await promise
    expect(result).toEqual(response)
    expect(fake.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('drain preserves submission order (FIFO)', async () => {
    const fake = makeFakeWsClient()
    fake.sendRequest.mockRejectedValue(parkable('WebSocket is not connected'))

    const queue = new OutboundQueue(fake, silentLogger)
    const p1 = queue.submit('m1', { id: 1 })
    const p2 = queue.submit('m2', { id: 2 })
    const p3 = queue.submit('m3', { id: 3 })
    await new Promise((r) => setTimeout(r, 10))

    const drainOrder: string[] = []
    fake.sendRequest.mockReset()
    fake.sendRequest.mockImplementation(async (method) => {
      drainOrder.push(method)
      return { type: 2, id: 1, payload: { errorCode: 0 } }
    })
    fake.fireAuth()

    await Promise.all([p1, p2, p3])
    expect(drainOrder).toEqual(['m1', 'm2', 'm3'])
  })

  it('logs info on park with method/attempt/reason fields', async () => {
    const fake = makeFakeWsClient()
    const info = vi.fn()
    const logger = { info, warn: () => {}, error: () => {} }
    fake.sendRequest.mockRejectedValueOnce(parkable('WebSocket is not connected'))

    const queue = new OutboundQueue(fake, logger)
    void queue.submit('sendMessage', { chatId: 'c1' })
    await new Promise((r) => setTimeout(r, 10))

    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/outbound parked: method=sendMessage attempt=1 reason=WebSocket is not connected/),
    )
  })

  it('concurrent auth events do not double-attempt items (draining mutex)', async () => {
    const fake = makeFakeWsClient()
    let unblock: () => void = () => {}
    const blocked = new Promise<TrueConfResponse>((resolve) => {
      unblock = () => resolve({ type: 2, id: 1, payload: { errorCode: 0 } })
    })
    fake.sendRequest
      .mockRejectedValueOnce(parkable('WebSocket is not connected'))
      .mockReturnValueOnce(blocked)

    const queue = new OutboundQueue(fake, silentLogger)
    const promise = queue.submit('m1', { id: 1 })
    await new Promise((r) => setTimeout(r, 10))

    fake.fireAuth()
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.sendRequest).toHaveBeenCalledTimes(2)

    fake.fireAuth()
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.sendRequest).toHaveBeenCalledTimes(2)

    unblock()
    await promise
    expect(fake.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('failAll(err) rejects all pending items and unsubscribes onAuth', async () => {
    const fake = makeFakeWsClient()
    fake.sendRequest.mockRejectedValue(parkable('WebSocket is not connected'))

    const queue = new OutboundQueue(fake, silentLogger)
    const p1 = queue.submit('m1', {})
    const p2 = queue.submit('m2', {})
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.authListeners.length).toBe(1)

    const terminal = new Error('lifecycle shutting down')
    queue.failAll(terminal)

    await expect(p1).rejects.toThrow('lifecycle shutting down')
    await expect(p2).rejects.toThrow('lifecycle shutting down')
    expect(fake.authListeners.length).toBe(0)
  })

  it('submit after failAll throws terminal error immediately', async () => {
    const fake = makeFakeWsClient()
    const queue = new OutboundQueue(fake, silentLogger)
    queue.failAll(new Error('terminal'))

    await expect(queue.submit('m1', {})).rejects.toThrow('terminal')
    expect(fake.sendRequest).not.toHaveBeenCalled()
  })

  it('failAll is idempotent — second call is no-op', async () => {
    const fake = makeFakeWsClient()
    fake.sendRequest.mockRejectedValue(parkable('WebSocket is not connected'))

    const queue = new OutboundQueue(fake, silentLogger)
    const p1 = queue.submit('m1', {})
    await new Promise((r) => setTimeout(r, 10))

    queue.failAll(new Error('first'))
    queue.failAll(new Error('second'))

    await expect(p1).rejects.toThrow('first')
  })

  it('response with errorCode != 0 still resolves (queue does not retry on application errors)', async () => {
    const fake = makeFakeWsClient()
    const erroredResponse: TrueConfResponse = {
      type: 2, id: 1, payload: { errorCode: 304, errorDescription: 'CHAT_NOT_FOUND' },
    }
    fake.sendRequest.mockResolvedValueOnce(erroredResponse)

    const queue = new OutboundQueue(fake, silentLogger)
    const result = await queue.submit('sendMessage', {})

    expect(result).toEqual(erroredResponse)
    expect(fake.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('race: failAll fires while sendRequest in flight — no double-settle', async () => {
    const fake = makeFakeWsClient()
    let resolveSendRequest: (resp: TrueConfResponse) => void = () => {}
    const inFlight = new Promise<TrueConfResponse>((resolve) => {
      resolveSendRequest = resolve
    })
    fake.sendRequest.mockReturnValueOnce(inFlight)

    const queue = new OutboundQueue(fake, silentLogger)
    const p1 = queue.submit('m1', {})
    await new Promise((r) => setTimeout(r, 10))

    queue.failAll(new Error('terminal during in-flight'))
    await expect(p1).rejects.toThrow('terminal during in-flight')

    resolveSendRequest({ type: 2, id: 1, payload: { errorCode: 0 } })
    await new Promise((r) => setTimeout(r, 10))

    let stillRejected = false
    await p1.catch(() => { stillRejected = true })
    expect(stillRejected).toBe(true)
  })

  it('does not double-send on 203 reconnect race', async () => {
    // Simulates the post-203 race: outer attempt() is suspended at
    // `await client.sendRequest(...)` while forceReconnect → start → connect
    // fires onAuth synchronously. Drain must not re-fire the same item while
    // the outer call is still in-flight.
    const fake = makeFakeWsClient()
    let resolveSendRequest: (resp: TrueConfResponse) => void = () => {}
    const inFlight = new Promise<TrueConfResponse>((resolve) => {
      resolveSendRequest = resolve
    })
    fake.sendRequest.mockReturnValueOnce(inFlight)

    const queue = new OutboundQueue(fake, silentLogger)
    const promise = queue.submit('sendMessage', { chatId: 'c1' })
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.sendRequest).toHaveBeenCalledTimes(1)

    // Auth fires while the first sendRequest is still pending — drain MUST
    // skip the in-flight item, not re-issue it.
    fake.fireAuth()
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.sendRequest).toHaveBeenCalledTimes(1)

    resolveSendRequest({ type: 2, id: 1, payload: { errorCode: 0 } })
    const result = await promise
    expect(result.payload?.errorCode).toBe(0)
    expect(fake.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('does not log misleading park line after failAll race', async () => {
    const fake = makeFakeWsClient()
    const info = vi.fn()
    const warn = vi.fn()
    const logger = { info, warn, error: () => {} }

    let rejectSendRequest: (err: Error) => void = () => {}
    const deferred = new Promise<TrueConfResponse>((_, reject) => {
      rejectSendRequest = reject
    })
    fake.sendRequest.mockReturnValueOnce(deferred)

    const queue = new OutboundQueue(fake, logger)
    const p1 = queue.submit('sendMessage', { chatId: 'c1' })
    await new Promise((r) => setTimeout(r, 10))

    queue.failAll(new Error('lifecycle shutting down'))
    rejectSendRequest(parkable('WebSocket closed: 1000'))

    await expect(p1).rejects.toThrow('lifecycle shutting down')
    await new Promise((r) => setTimeout(r, 10))

    const parkCalls = info.mock.calls.filter(([msg]) => /outbound parked/.test(String(msg)))
    expect(parkCalls).toHaveLength(0)
  })

  it('warns on non-reconnectable error after failAll instead of silently swallowing', async () => {
    const fake = makeFakeWsClient()
    const info = vi.fn()
    const warn = vi.fn()
    const logger = { info, warn, error: () => {} }

    let rejectSendRequest: (err: Error) => void = () => {}
    const deferred = new Promise<TrueConfResponse>((_, reject) => {
      rejectSendRequest = reject
    })
    fake.sendRequest.mockReturnValueOnce(deferred)

    const queue = new OutboundQueue(fake, logger)
    const p1 = queue.submit('sendMessage', { chatId: 'c1' })
    await new Promise((r) => setTimeout(r, 10))

    queue.failAll(new Error('lifecycle shutting down'))
    rejectSendRequest(new Error('boom'))

    await expect(p1).rejects.toThrow('lifecycle shutting down')
    await new Promise((r) => setTimeout(r, 10))

    const matched = warn.mock.calls.filter(([msg]) =>
      /non-reconnectable error after terminal/.test(String(msg)),
    )
    expect(matched).toHaveLength(1)
  })

  it('increments attempts counter across re-parks', async () => {
    const fake = makeFakeWsClient()
    const info = vi.fn()
    const logger = { info, warn: () => {}, error: () => {} }

    fake.sendRequest
      .mockRejectedValueOnce(parkable('WebSocket is not connected'))
      .mockRejectedValueOnce(parkable('WebSocket is not connected'))
      .mockResolvedValueOnce({ type: 2, id: 1, payload: { errorCode: 0 } })

    const queue = new OutboundQueue(fake, logger)
    const promise = queue.submit('sendMessage', { chatId: 'c1' })
    await new Promise((r) => setTimeout(r, 10))

    fake.fireAuth()
    await new Promise((r) => setTimeout(r, 10))

    const parkLines = info.mock.calls
      .map(([msg]) => String(msg))
      .filter((m) => /outbound parked/.test(m))
    expect(parkLines).toHaveLength(2)
    expect(parkLines[0]).toMatch(/attempt=1/)
    expect(parkLines[1]).toMatch(/attempt=2/)

    fake.fireAuth()
    const result = await promise
    expect(result.payload?.errorCode).toBe(0)
  })

  it('emits terminal warn log on failAll with drained count', async () => {
    const fake = makeFakeWsClient()
    const warn = vi.fn()
    const logger = { info: () => {}, warn, error: () => {} }
    fake.sendRequest.mockRejectedValue(parkable('WebSocket is not connected'))

    const queue = new OutboundQueue(fake, logger)
    const p1 = queue.submit('m1', {})
    const p2 = queue.submit('m2', {})
    await new Promise((r) => setTimeout(r, 10))

    queue.failAll(new Error('terminal'))

    await expect(p1).rejects.toThrow('terminal')
    await expect(p2).rejects.toThrow('terminal')

    const matched = warn.mock.calls
      .map(([msg]) => String(msg))
      .filter((m) => /outbound queue terminal:.*drained=2/.test(m))
    expect(matched).toHaveLength(1)
  })
})
