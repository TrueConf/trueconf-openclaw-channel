import { describe, it, expect } from 'vitest'
import { readTrueConfSection } from '../../src/types'

describe('readTrueConfSection', () => {
  it('returns empty object on missing channels', () => {
    expect(readTrueConfSection({} as never)).toEqual({})
  })

  it('returns empty object on missing trueconf channel', () => {
    expect(readTrueConfSection({ channels: {} } as never)).toEqual({})
  })

  it('returns empty object when trueconf is not an object (string)', () => {
    expect(readTrueConfSection({ channels: { trueconf: 'oops' } } as never)).toEqual({})
  })

  it('returns empty object when trueconf is null', () => {
    expect(readTrueConfSection({ channels: { trueconf: null } } as never)).toEqual({})
  })

  it('returns the section when it is a valid object', () => {
    const tc = { serverUrl: 'tc.example.com', useTls: true, tlsVerify: false }
    expect(readTrueConfSection({ channels: { trueconf: tc } } as never)).toBe(tc)
  })
})
