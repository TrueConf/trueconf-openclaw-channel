import { afterEach, describe, expect, it, vi } from 'vitest'
import { DisplayNames } from '../../src/display-names'

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

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
    }, logger(), 60_000)

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

  it('falls back to the userId on an error or an empty name and asks again next time', async () => {
    const replies: Array<() => Promise<string | null>> = [
      async () => { throw new Error('errorCode 304') },
      async () => null,
      async () => 'Боб',
    ]
    const log = logger()
    const names = new DisplayNames(() => replies.shift()!(), log)

    const results = [await names.resolve('b@srv'), await names.resolve('b@srv'), await names.resolve('b@srv')]

    expect(results).toEqual(['b@srv', 'b@srv', 'Боб'])
    expect(log.warn.mock.calls).toEqual([
      ['[trueconf] getUserDisplayName failed for b@srv: errorCode 304; using the id'],
    ])
  })

  it('returns the userId after the timeout and keeps a late answer for the next lookup', async () => {
    vi.useFakeTimers()
    let answer!: (name: string) => void
    const names = new DisplayNames(
      () => new Promise<string>((resolve) => { answer = resolve }),
      logger(),
      60_000,
      3_000,
    )

    const slow = names.resolve('c@srv')
    await vi.advanceTimersByTimeAsync(3_000)
    const timedOut = await slow
    answer('Кэрол')
    await vi.advanceTimersByTimeAsync(0)
    const late = await names.resolve('c@srv')

    expect({ timedOut, late }).toEqual({ timedOut: 'c@srv', late: 'Кэрол' })
  })
})
