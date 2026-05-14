import { describe, it, expect } from 'vitest'
import {
  serializeError,
  deserializeError,
  PROTOCOL_VERSION,
} from '../../src/ws-worker-protocol'

describe('ws-worker-protocol', () => {
  it('PROTOCOL_VERSION is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it('serializes Error preserving name/message/code/parkable/stack', () => {
    const err = Object.assign(new TypeError('boom'), { code: 'EPARK', parkable: true })
    const s = serializeError(err)
    expect(s.name).toBe('TypeError')
    expect(s.message).toBe('boom')
    expect(s.code).toBe('EPARK')
    expect(s.parkable).toBe(true)
    expect(typeof s.stack).toBe('string')
  })

  it('serializes non-Error to a generic shape', () => {
    const s = serializeError('plain string')
    expect(s.name).toBe('Error')
    expect(s.message).toBe('plain string')
    expect(s.parkable).toBe(false)
  })

  it('round-trip Error: serialize then deserialize preserves identity', () => {
    const err = Object.assign(new RangeError('out of range'), { parkable: false, code: 'EBAD' })
    const back = deserializeError(serializeError(err))
    expect(back.name).toBe('RangeError')
    expect(back.message).toBe('out of range')
    expect((back as { parkable?: boolean }).parkable).toBe(false)
    expect((back as { code?: string }).code).toBe('EBAD')
  })
})
