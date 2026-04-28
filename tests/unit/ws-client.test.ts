import { describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import { acquireToken, WsClient } from '../../src/ws-client'

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, fetch: vi.fn(actual.fetch) }
})

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
})
