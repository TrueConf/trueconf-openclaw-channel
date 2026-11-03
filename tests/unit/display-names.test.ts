import { afterEach, describe, expect, it, vi } from 'vitest'
import { DisplayNames } from '../../src/display-names'

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const timings = { ttlMs: 60_000, retryMs: 300_000, timeoutMs: 3_000 }

describe('DisplayNames', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks the server once for concurrent and repeated lookups, then again after the TTL', async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const names = new DisplayNames(async (userId) => {
      asked.push(userId)
      return `Name of ${userId}`
    }, logger(), timings)

    const first = await Promise.all([names.resolve('a@srv'), names.resolve('a@srv')])
    const cached = await names.resolve('a@srv')
    vi.advanceTimersByTime(60_001)
    const expired = await names.resolve('a@srv')

    expect({ first, cached, expired, asked }).toEqual({
      first: ['Name of a@srv', 'Name of a@srv'],
      cached: 'Name of a@srv',
      expired: 'Name of a@srv',
      asked: ['a@srv', 'a@srv'],
    })
  })

  it('answers with the userId after an error or an empty name and asks again only after retryMs', async () => {
    vi.useFakeTimers()
    const replies: Array<() => Promise<string | null>> = [
      async () => { throw new Error('errorCode 304') },
      async () => null,
      async () => 'Боб',
    ]
    const log = logger()
    const names = new DisplayNames(() => replies.shift()!(), log, timings)

    const afterError = await names.resolve('b@srv')
    const withinRetry = await names.resolve('b@srv')
    vi.advanceTimersByTime(300_001)
    const afterEmpty = await names.resolve('b@srv')
    vi.advanceTimersByTime(300_001)
    const found = await names.resolve('b@srv')

    expect({ afterError, withinRetry, afterEmpty, found, unasked: replies.length, warnings: log.warn.mock.calls }).toEqual({
      afterError: 'b@srv',
      withinRetry: 'b@srv',
      afterEmpty: 'b@srv',
      found: 'Боб',
      unasked: 0,
      warnings: [['[trueconf] getUserDisplayName failed for b@srv: errorCode 304; using the id']],
    })
  })

  it('returns the userId after the timeout, answers at once while the lookup hangs, and keeps a late answer', async () => {
    vi.useFakeTimers()
    let answer!: (name: string) => void
    const names = new DisplayNames(() => new Promise<string>((resolve) => { answer = resolve }), logger(), timings)

    const slow = names.resolve('c@srv')
    await vi.advanceTimersByTimeAsync(3_000)
    const timedOut = await slow
    const whileHanging = await names.resolve('c@srv')
    answer('Кэрол')
    await vi.advanceTimersByTimeAsync(0)
    const late = await names.resolve('c@srv')

    expect({ timedOut, whileHanging, late }).toEqual({ timedOut: 'c@srv', whileHanging: 'c@srv', late: 'Кэрол' })
  })
})
