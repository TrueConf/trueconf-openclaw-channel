import { describe, it, expect, vi } from 'vitest'
import { OutboundQueue } from '../../src/outbound-queue'
import type { Logger, TrueConfResponse } from '../../src/types'

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

interface FakeWsClient {
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

    const queue = new OutboundQueue(fake as never, silentLogger)
    const result = await queue.submit('sendMessage', { chatId: 'c1', text: 'hi' })

    expect(result).toEqual(response)
    expect(fake.sendRequest).toHaveBeenCalledTimes(1)
    expect(fake.sendRequest).toHaveBeenCalledWith('sendMessage', { chatId: 'c1', text: 'hi' })
  })

  it('parks on "WebSocket is not connected" — does not resolve or reject yet', async () => {
    const fake = makeFakeWsClient()
    fake.sendRequest.mockRejectedValueOnce(new Error('WebSocket is not connected'))

    const queue = new OutboundQueue(fake as never, silentLogger)
    let settled = false
    const promise = queue.submit('sendMessage', { chatId: 'c1' }).finally(() => { settled = true })

    await new Promise((r) => setTimeout(r, 10))

    expect(settled).toBe(false)
    expect(fake.sendRequest).toHaveBeenCalledTimes(1)
    void promise
  })

  it.each([
    ['"WebSocket closed: 1006"', new Error('WebSocket closed: 1006 ')],
    ['"auth barrier reset: forced reconnect: 203"', new Error('auth barrier reset: forced reconnect: 203_credentials_expired')],
    ['"waitAuthenticated timed out after 30000ms"', new Error('waitAuthenticated timed out after 30000ms')],
    ['"New connection started"', new Error('New connection started')],
  ])('parks on %s', async (_label, err) => {
    const fake = makeFakeWsClient()
    fake.sendRequest.mockRejectedValueOnce(err)

    const queue = new OutboundQueue(fake as never, silentLogger)
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
      .mockRejectedValueOnce(new Error('WebSocket is not connected'))
      .mockResolvedValueOnce(response)

    const queue = new OutboundQueue(fake as never, silentLogger)
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
    fake.sendRequest.mockRejectedValue(new Error('WebSocket is not connected'))

    const queue = new OutboundQueue(fake as never, silentLogger)
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
    fake.sendRequest.mockRejectedValueOnce(new Error('WebSocket is not connected'))

    const queue = new OutboundQueue(fake as never, logger)
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
      .mockRejectedValueOnce(new Error('WebSocket is not connected'))
      .mockReturnValueOnce(blocked)

    const queue = new OutboundQueue(fake as never, silentLogger)
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
    fake.sendRequest.mockRejectedValue(new Error('WebSocket is not connected'))

    const queue = new OutboundQueue(fake as never, silentLogger)
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
    const queue = new OutboundQueue(fake as never, silentLogger)
    queue.failAll(new Error('terminal'))

    await expect(queue.submit('m1', {})).rejects.toThrow('terminal')
    expect(fake.sendRequest).not.toHaveBeenCalled()
  })

  it('failAll is idempotent — second call is no-op', async () => {
    const fake = makeFakeWsClient()
    fake.sendRequest.mockRejectedValue(new Error('WebSocket is not connected'))

    const queue = new OutboundQueue(fake as never, silentLogger)
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

    const queue = new OutboundQueue(fake as never, silentLogger)
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

    const queue = new OutboundQueue(fake as never, silentLogger)
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
})
