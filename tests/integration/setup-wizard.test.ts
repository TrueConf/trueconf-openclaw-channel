import { describe, it, expect } from 'vitest'

// These tests require the fake-server OAuth token endpoint and a fake-prompter
// implementation, both of which are added in Part 4 (Tasks 18-19). The skipped
// tests document the expected finalize behavior now so implementation stays
// honest.

describe('interactiveFinalize', () => {
  it('writes channels.trueconf after successful OAuth', async () => {
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { interactiveFinalize } = await import('../../src/channel-setup')

    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    try {
      const prompter = makeFakePrompter({})
      const cfg = {
        channels: { trueconf: {
          serverUrl: fake.host,
          username: 'bot@localhost',
          useTls: false,
          port: fake.port,
        } },
      }
      const credentialValues = { password: 'secret' }

      const result = await interactiveFinalize({
        cfg: cfg as never,
        prompter,
        credentialValues,
        accountId: 'default',
        runtime: undefined as never,
        forceAllowFrom: false,
      })

      expect(result?.cfg).toBeDefined()
      const tc = (result!.cfg as never as { channels: { trueconf: { password: string } } }).channels.trueconf
      expect(tc.password).toBe('secret')
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('retries password up to 3 times on 401, then throws invalid-credentials', async () => {
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { interactiveFinalize } = await import('../../src/channel-setup')

    // fake-server returns 401 for every OAuth call → 3 attempts, all fail.
    const fake = await (startFakeServer as (opts: unknown) => Promise<{
      host: string
      port: number
      oauthRequests: unknown[]
    }>)({ oauthResponse: { status: 401 } })
    try {
      // 2 extra password re-prompts (attempt 2 + attempt 3). The 3rd failure is
      // fatal and throws — no 4th prompt happens.
      const prompter = makeFakePrompter({
        textResponses: ['wrong-again', 'still-wrong'],
      })

      const cfg = {
        channels: { trueconf: {
          serverUrl: fake.host,
          username: 'bot@localhost',
          useTls: false,
          port: fake.port,
        } },
      }

      await expect(interactiveFinalize({
        cfg: cfg as never,
        prompter,
        credentialValues: { password: 'wrong' },
        accountId: 'default',
        runtime: undefined as never,
        forceAllowFrom: false,
      })).rejects.toThrow(/invalid-credentials/)

      // Sanity: exactly 3 OAuth calls were made (no 4th after giving up).
      expect(fake.oauthRequests.length).toBe(3)
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  // Locks in the retry contract documented in channel-setup.ts:231-232 —
  // only `invalid-credentials` retries; every other OAuth failure category
  // (server-error, network, tls, token-endpoint-missing, unknown) is fatal
  // after a single attempt. Unit tests cover that validateOAuthCredentials
  // correctly classifies each status code; this test proves the control-flow
  // gate in the finalize loop honors the classification.
  it('does NOT retry on server-error (500), throws after single attempt', async () => {
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { interactiveFinalize } = await import('../../src/channel-setup')

    const fake = await (startFakeServer as (opts: unknown) => Promise<{
      host: string
      port: number
      oauthRequests: unknown[]
    }>)({ oauthResponse: { status: 500 } })
    try {
      const prompter = makeFakePrompter({ textResponses: [], selectResponses: [] })

      const cfg = {
        channels: { trueconf: {
          serverUrl: fake.host,
          username: 'bot@localhost',
          useTls: false,
          port: fake.port,
        } },
      }

      await expect(interactiveFinalize({
        cfg: cfg as never,
        prompter,
        credentialValues: { password: 'any' },
        accountId: 'default',
        runtime: undefined as never,
        forceAllowFrom: false,
      })).rejects.toThrow(/server-error/)

      // NO retries on non-invalid-credentials categories.
      expect(fake.oauthRequests.length).toBe(1)
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })
})

describe('runHeadlessFinalize', () => {
  it('writes cfg from TRUECONF_* env vars without prompts', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    process.env.TRUECONF_SERVER_URL = fake.host
    process.env.TRUECONF_USERNAME = 'bot@localhost'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = String(fake.port)
    try {
      const { runHeadlessFinalize } = await import('../../src/channel-setup')
      const result = await runHeadlessFinalize({ channels: {} } as never)
      const tc = (result as never as { channels: { trueconf: unknown } }).channels.trueconf
      expect(tc).toBeDefined()
    } finally {
      delete process.env.TRUECONF_SERVER_URL
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
      delete process.env.TRUECONF_USE_TLS
      delete process.env.TRUECONF_PORT
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('throws on OAuth 401 without retry', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 401 } },
    )
    process.env.TRUECONF_SERVER_URL = fake.host
    process.env.TRUECONF_USERNAME = 'bot@localhost'
    process.env.TRUECONF_PASSWORD = 'wrong'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = String(fake.port)
    try {
      const { runHeadlessFinalize } = await import('../../src/channel-setup')
      await expect(runHeadlessFinalize({ channels: {} } as never))
        .rejects.toThrow(/invalid-credentials/)
    } finally {
      delete process.env.TRUECONF_SERVER_URL
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
      delete process.env.TRUECONF_USE_TLS
      delete process.env.TRUECONF_PORT
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })
})
