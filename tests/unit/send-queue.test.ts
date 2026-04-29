import { describe, it, expect } from 'vitest'
import { PerChatSendQueue } from '../../src/send-queue'

function makeDeferred<T = void>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (err: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('PerChatSendQueue', () => {
  it('two enqueues to same chatId: second waits for first', async () => {
    const q = new PerChatSendQueue()
    const dA = makeDeferred<string>()
    const events: string[] = []

    const a = q.enqueue('chat-X', async () => {
      events.push('A-start')
      const r = await dA.promise
      events.push('A-end')
      return r
    })

    const b = q.enqueue('chat-X', async () => {
      events.push('B-start')
      return 'B-done'
    })

    // Let microtasks settle so 'A-start' fires.
    await Promise.resolve()
    await Promise.resolve()

    // B has NOT started yet — it's waiting on A's tail.
    expect(events).toEqual(['A-start'])

    // Resolve A; now B should run.
    dA.resolve('A-done')
    expect(await a).toBe('A-done')
    expect(await b).toBe('B-done')
    expect(events).toEqual(['A-start', 'A-end', 'B-start'])
  })

  it('two enqueues to different chatIds: both run in parallel', async () => {
    const q = new PerChatSendQueue()
    const dA = makeDeferred<string>()
    const dB = makeDeferred<string>()
    const events: string[] = []

    const a = q.enqueue('chat-A', async () => {
      events.push('A-start')
      return dA.promise
    })

    const b = q.enqueue('chat-B', async () => {
      events.push('B-start')
      return dB.promise
    })

    await Promise.resolve()
    await Promise.resolve()

    // BOTH started — different chats run in parallel.
    expect(events).toEqual(['A-start', 'B-start'])

    dB.resolve('B-done')
    dA.resolve('A-done')
    await Promise.all([a, b])
  })

  it('first task throws: second still runs (chain survives error)', async () => {
    const q = new PerChatSendQueue()
    const events: string[] = []

    const a = q.enqueue('chat-X', async () => {
      events.push('A-start')
      throw new Error('A failed')
    })

    const b = q.enqueue('chat-X', async () => {
      events.push('B-start')
      return 'B-done'
    })

    await expect(a).rejects.toThrow('A failed')
    expect(await b).toBe('B-done')
    expect(events).toEqual(['A-start', 'B-start'])
  })

  it('cleanup: tails map empties after last enqueue settles', async () => {
    const q = new PerChatSendQueue()
    expect(q.size()).toBe(0)

    const dA = makeDeferred<void>()
    const a = q.enqueue('chat-X', () => dA.promise)
    expect(q.size()).toBe(1)

    dA.resolve()
    await a
    // Allow finally callback to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(q.size()).toBe(0)
  })

  it('100 enqueues to same chatId all run in submission order', async () => {
    const q = new PerChatSendQueue()
    const order: number[] = []
    const tasks: Promise<unknown>[] = []

    for (let i = 0; i < 100; i++) {
      tasks.push(
        q.enqueue('chat-X', async () => {
          order.push(i)
        }),
      )
    }

    await Promise.all(tasks)
    const expected = Array.from({ length: 100 }, (_, i) => i)
    expect(order).toEqual(expected)
  })

  it('enqueue while previous still pending: tail updated to latest', async () => {
    const q = new PerChatSendQueue()
    const dA = makeDeferred<void>()
    const dB = makeDeferred<void>()

    const a = q.enqueue('chat-X', () => dA.promise)
    const tailAfterA = (q as unknown as { tails: Map<string, Promise<unknown>> }).tails.get('chat-X')
    expect(tailAfterA).toBeDefined()

    const b = q.enqueue('chat-X', () => dB.promise)
    const tailAfterB = (q as unknown as { tails: Map<string, Promise<unknown>> }).tails.get('chat-X')
    expect(tailAfterB).toBeDefined()
    expect(tailAfterB).not.toBe(tailAfterA) // tail updated

    dA.resolve()
    dB.resolve()
    await Promise.all([a, b])
  })
})
