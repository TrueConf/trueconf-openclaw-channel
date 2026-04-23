import { describe, it, expect, vi } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('channel.ts caPath plumbing', () => {
  it('loadCaFromAccount returns Buffer when caPath file exists', async () => {
    const { loadCaFromAccount } = await import('../../src/channel')
    const dir = mkdtempSync(join(tmpdir(), 'tc-ca-'))
    const caPath = join(dir, 'ca.pem')
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n')

    const ca = loadCaFromAccount({
      accountId: 'default',
      configured: true,
      enabled: true,
      serverUrl: 'tc.example.com',
      username: 'bot',
      password: 'pw',
      caPath,
    })
    expect(ca).toBeInstanceOf(Buffer)
    expect(ca!.toString('utf8')).toContain('BEGIN CERTIFICATE')
  })

  it('loadCaFromAccount returns undefined when caPath not set', async () => {
    const { loadCaFromAccount } = await import('../../src/channel')
    const ca = loadCaFromAccount({
      accountId: 'default',
      configured: true,
      enabled: true,
      serverUrl: 'tc.example.com',
      username: 'bot',
      password: 'pw',
    })
    expect(ca).toBeUndefined()
  })

  it('loadCaFromAccount throws when caPath set but file does not exist', async () => {
    const { loadCaFromAccount } = await import('../../src/channel')
    expect(() =>
      loadCaFromAccount({
        accountId: 'default',
        configured: true,
        enabled: true,
        serverUrl: 'tc.example.com',
        username: 'bot',
        password: 'pw',
        caPath: '/nonexistent/path/ca.pem',
      }),
    ).toThrow(/trust anchor unreadable.*\/nonexistent\/path\/ca\.pem/)
  })
})

describe('shutdownAccountEntry', () => {
  it('calls lifecycle.shutdown() and dispatcher.close()', async () => {
    const { shutdownAccountEntry } = await import('../../src/channel')
    const shutdown = vi.fn()
    const close = vi.fn().mockResolvedValue(undefined)
    const entry = {
      lifecycle: { shutdown } as never,
      wsClient: {} as never,
      dispatcher: { close } as never,
    }
    shutdownAccountEntry(entry)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('calls lifecycle.shutdown() only when dispatcher is absent', async () => {
    const { shutdownAccountEntry } = await import('../../src/channel')
    const shutdown = vi.fn()
    const entry = {
      lifecycle: { shutdown } as never,
      wsClient: {} as never,
    }
    shutdownAccountEntry(entry)
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('swallows dispatcher.close() rejections (best-effort)', async () => {
    const { shutdownAccountEntry } = await import('../../src/channel')
    const shutdown = vi.fn()
    const close = vi.fn().mockRejectedValue(new Error('boom'))
    const entry = {
      lifecycle: { shutdown } as never,
      wsClient: {} as never,
      dispatcher: { close } as never,
    }
    // Must not throw, even with the rejected promise pending.
    expect(() => shutdownAccountEntry(entry)).not.toThrow()
    // Let the microtask queue drain so the .catch() is reached.
    await new Promise<void>((r) => setImmediate(r))
    expect(close).toHaveBeenCalledOnce()
  })
})
