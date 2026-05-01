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
})
