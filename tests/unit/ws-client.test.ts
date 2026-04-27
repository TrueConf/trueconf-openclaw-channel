import { describe, expect, it, vi } from 'vitest'
import { acquireToken } from '../../src/ws-client'

describe('acquireToken', () => {
  it('includes undici fetch cause in startup OAuth errors', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => {
      const cause = new Error('unable to verify the first certificate') as Error & { code: string }
      cause.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      throw new TypeError('fetch failed', { cause })
    })
    try {
      await expect(acquireToken({
        serverUrl: 'tc.example.com',
        username: 'bot',
        password: 'secret',
        useTls: true,
        port: 443,
      })).rejects.toThrow(/fetch failed.*UNABLE_TO_VERIFY_LEAF_SIGNATURE.*unable to verify the first certificate/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
