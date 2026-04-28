import { describe, expect, it } from 'vitest'
import { NetworkError, DNS_ERROR_CODES, EnvelopeType, buildAuthRequest } from '../../src/types'

describe('NetworkError', () => {
  it('preserves cause, code, syscall, hostname', () => {
    const cause = Object.assign(new Error('original'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'bad.example' })
    const err = new NetworkError('OAuth token request failed', 'oauth', cause, 'ENOTFOUND', 'getaddrinfo', 'bad.example')
    expect(err.name).toBe('NetworkError')
    expect(err.phase).toBe('oauth')
    expect(err.cause).toBe(cause)
    expect(err.code).toBe('ENOTFOUND')
    expect(err.syscall).toBe('getaddrinfo')
    expect(err.hostname).toBe('bad.example')
  })

  it('phase is one of the documented values', () => {
    const phases: ReadonlyArray<NetworkError['phase']> = ['oauth', 'websocket', 'ws-handshake', 'ws-message', 'unknown']
    for (const p of phases) {
      expect(new NetworkError('msg', p).phase).toBe(p)
    }
  })
})

describe('DNS_ERROR_CODES', () => {
  it('contains all four DNS-class codes', () => {
    expect(DNS_ERROR_CODES.has('ENOTFOUND')).toBe(true)
    expect(DNS_ERROR_CODES.has('EAI_AGAIN')).toBe(true)
    expect(DNS_ERROR_CODES.has('EAI_NODATA')).toBe(true)
    expect(DNS_ERROR_CODES.has('EAI_NONAME')).toBe(true)
  })

  it('does not contain transient connection codes', () => {
    expect(DNS_ERROR_CODES.has('ECONNREFUSED')).toBe(false)
    expect(DNS_ERROR_CODES.has('ETIMEDOUT')).toBe(false)
    expect(DNS_ERROR_CODES.has('ECONNRESET')).toBe(false)
  })
})

describe('EnvelopeType', () => {
  it('has LOCATION = 203', () => {
    expect(EnvelopeType.LOCATION).toBe(203)
  })
})

describe('buildAuthRequest', () => {
  it('default options: receiveUnread=false, receiveSystemMessageEnvelopes=false (Python parity)', () => {
    const req = buildAuthRequest(7, 'jwt-token')
    expect(req).toEqual({
      type: 1,
      id: 7,
      method: 'auth',
      payload: {
        token: 'jwt-token',
        tokenType: 'JWT',
        receiveUnread: false,
        receiveSystemMessageEnvelopes: false,
      },
    })
  })

  it('respects explicit options', () => {
    const req = buildAuthRequest(8, 'tok', { receiveUnread: true, receiveSystemMessageEnvelopes: true })
    expect(req.payload).toMatchObject({ receiveUnread: true, receiveSystemMessageEnvelopes: true })
  })
})
