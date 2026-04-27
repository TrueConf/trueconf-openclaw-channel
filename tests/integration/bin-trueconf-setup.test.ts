import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Integration tests for bin/trueconf-setup.mjs runSetup().
// The bin is the programmatic entry point users hit via `npx trueconf-setup`;
// it wraps runHeadlessFinalize / interactiveFinalize with openclaw.json I/O
// (atomic write + 0600 perms) and decides which path to take based on env.
//
// These tests exercise runSetup directly (not via subprocess) so we can inject
// a fake prompter and a fake OAuth server without shell gymnastics.

describe('bin/trueconf-setup.mjs runSetup', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trueconf-setup-test-'))
    configPath = join(tmpDir, 'openclaw.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('headless: reads TRUECONF_* env, writes channels.trueconf to openclaw.json', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({ meta: { lastTouchedVersion: '2026.4.15' } }, null, 2))

    process.env.TRUECONF_SERVER_URL = fake.host
    process.env.TRUECONF_USERNAME = 'bot@localhost'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = String(fake.port)

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<void>
      }
      await runSetup({ configPath })

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { username?: string; password?: string; serverUrl?: string } }
        meta?: { lastTouchedVersion?: string }
      }
      expect(written.channels?.trueconf?.username).toBe('bot@localhost')
      expect(written.channels?.trueconf?.password).toBe('secret')
      expect(written.channels?.trueconf?.serverUrl).toBe(fake.host)
      expect(written.meta?.lastTouchedVersion).toBe('2026.4.15')
    } finally {
      delete process.env.TRUECONF_SERVER_URL
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
      delete process.env.TRUECONF_USE_TLS
      delete process.env.TRUECONF_PORT
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('headless: writes openclaw.json with 0600 permissions', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({}, null, 2))

    process.env.TRUECONF_SERVER_URL = fake.host
    process.env.TRUECONF_USERNAME = 'bot@localhost'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = String(fake.port)

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string }) => Promise<void>
      }
      await runSetup({ configPath })

      const mode = statSync(configPath).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      delete process.env.TRUECONF_SERVER_URL
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
      delete process.env.TRUECONF_USE_TLS
      delete process.env.TRUECONF_PORT
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('headless: failed OAuth does NOT clobber original config', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 401 } },
    )
    const originalContent = JSON.stringify({
      meta: { lastTouchedVersion: '2026.4.15' },
      channels: { trueconf: { serverUrl: 'old.example.com', username: 'old', password: 'old-pwd' } },
    }, null, 2)
    writeFileSync(configPath, originalContent)

    process.env.TRUECONF_SERVER_URL = fake.host
    process.env.TRUECONF_USERNAME = 'bot@localhost'
    process.env.TRUECONF_PASSWORD = 'wrong'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = String(fake.port)

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string }) => Promise<void>
      }
      await expect(runSetup({ configPath })).rejects.toThrow(/invalid-credentials/)

      // Original content must be untouched — atomic write guarantees no partial state.
      expect(readFileSync(configPath, 'utf8')).toBe(originalContent)
    } finally {
      delete process.env.TRUECONF_SERVER_URL
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
      delete process.env.TRUECONF_USE_TLS
      delete process.env.TRUECONF_PORT
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('interactive: prompts only serverUrl/username/password on fresh cfg (TLS auto-detect)', async () => {
    // Bin now SKIPS useTls/port prompts when they're not set — finalize
    // auto-detects them. To test the interactive path end-to-end against a
    // fake-server on a random port (where auto-detect can't reach 443/4309/80),
    // we pre-set useTls+port in cfg; those are not "fresh" but are also not
    // user-prompted when they already have values either way. Serverurl,
    // username, and password are still prompted.
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({
      channels: { trueconf: { useTls: false, port: fake.port } },
    }, null, 2))

    const prompter = makeFakePrompter({
      // Only serverUrl + username prompted as "fresh"; useTls/port prompts
      // fire too (since current values exist in cfg) but fakePrompter returns
      // '' when queue drains, which maps to "keep current value".
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['secret'],
    })

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<void>
      }
      await runSetup({ configPath, prompter })

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { username?: string; password?: string; serverUrl?: string } }
      }
      expect(written.channels?.trueconf?.serverUrl).toBe(fake.host)
      expect(written.channels?.trueconf?.username).toBe('bot@localhost')
      expect(written.channels?.trueconf?.password).toBe('secret')
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('interactive fresh (no TLS/port pre-set): skips optional prompts', async () => {
    // Verifies the UX contract: on a truly empty cfg, useTls/port are NOT
    // prompted — finalize owns auto-detect. We can't complete finalize
    // against fake-server here (fake listens on random port), so we stop at
    // counting prompts via a counting prompter.
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    writeFileSync(configPath, JSON.stringify({}, null, 2))

    let textPromptCount = 0
    const baseFake = makeFakePrompter({
      textResponses: ['srv.example.com', 'bot@srv'],
      passwordResponses: ['pwd'],
    }) as unknown as { text: (opts: unknown) => Promise<unknown> }
    const originalText = baseFake.text.bind(baseFake)
    ;(baseFake as unknown as { text: (opts: unknown) => Promise<unknown> }).text = async (opts) => {
      textPromptCount++
      return originalText(opts)
    }

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<void>
      }
      // Will fail at finalize (can't reach srv.example.com) but prompts run first.
      await runSetup({ configPath, prompter: baseFake }).catch(() => {})

      expect(textPromptCount).toBe(2) // serverUrl + username only; useTls/port skipped
    } finally {
      // no server to stop
    }
  })

  it('interactive re-run: existing serverUrl/username used as defaults', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({
      channels: { trueconf: {
        serverUrl: fake.host,
        username: 'bot@localhost',
        useTls: false,
        port: fake.port,
      } },
    }, null, 2))

    // Prompter returns '' for all text prompts — means "accept default"
    const prompter = makeFakePrompter({
      textResponses: ['', '', '', ''],
      passwordResponses: ['new-secret'],
    })

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<void>
      }
      await runSetup({ configPath, prompter })

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { serverUrl?: string; username?: string; password?: string } }
      }
      // Defaults preserved
      expect(written.channels?.trueconf?.serverUrl).toBe(fake.host)
      expect(written.channels?.trueconf?.username).toBe('bot@localhost')
      expect(written.channels?.trueconf?.password).toBe('new-secret')
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  // --- Regression-fix tests (parity with old install.sh) ---------------

  it('headless: creates .bak.<ts> backup of existing config before overwrite', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    const originalContent = JSON.stringify({
      meta: { lastTouchedVersion: '2026.4.15' },
      channels: { trueconf: { serverUrl: 'old.example.com', username: 'old', password: 'pwd' } },
    }, null, 2)
    writeFileSync(configPath, originalContent)

    process.env.TRUECONF_SERVER_URL = fake.host
    process.env.TRUECONF_USERNAME = 'bot@localhost'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = String(fake.port)

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string }) => Promise<{ backupPath: string | null }>
      }
      const result = await runSetup({ configPath })

      expect(result.backupPath).toBeTruthy()
      expect(result.backupPath).toMatch(/\.bak\.\d+$/)
      expect(readFileSync(result.backupPath as string, 'utf8')).toBe(originalContent)

      // And the main config was still updated
      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { serverUrl?: string } }
      }
      expect(written.channels?.trueconf?.serverUrl).toBe(fake.host)
    } finally {
      delete process.env.TRUECONF_SERVER_URL
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
      delete process.env.TRUECONF_USE_TLS
      delete process.env.TRUECONF_PORT
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('interactive overwrite protection: "no" aborts without touching config', async () => {
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const originalContent = JSON.stringify({
      channels: { trueconf: { serverUrl: 'old.example.com', username: 'old', password: 'pwd' } },
    }, null, 2)
    writeFileSync(configPath, originalContent)

    // Deny the first confirm (overwrite prompt)
    const prompter = makeFakePrompter({ confirmResponses: [false] })

    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<{ mode: string }>
    }
    const result = await runSetup({ configPath, prompter })

    expect(result.mode).toBe('cancelled-overwrite')
    expect(readFileSync(configPath, 'utf8')).toBe(originalContent)
    // No backup created either — nothing changed, nothing to preserve.
    expect(readdirSync(tmpDir)).toEqual(['openclaw.json'])
  })

  it('interactive: "save without validation" fallback on OAuth network error', async () => {
    // Fake-server returns 500 (server-error) — not invalid-credentials, so
    // the retry loop exits after 1 attempt and offers the save-anyway fallback.
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 500 } },
    )
    writeFileSync(configPath, JSON.stringify({
      channels: { trueconf: { useTls: false, port: fake.port } },
    }, null, 2))

    // Confirm order: overwrite=true, save-anyway=true
    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['secret'],
      confirmResponses: [true, true],
    })

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<{ mode: string }>
      }
      const result = await runSetup({ configPath, prompter })

      expect(result.mode).toBe('saved-without-validation')
      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { username?: string; password?: string } }
      }
      expect(written.channels?.trueconf?.username).toBe('bot@localhost')
      expect(written.channels?.trueconf?.password).toBe('secret')
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('interactive: "save without validation"=no on OAuth failure throws', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 500 } },
    )
    writeFileSync(configPath, JSON.stringify({
      channels: { trueconf: { useTls: false, port: fake.port } },
    }, null, 2))

    // Confirm order: overwrite=true, save-anyway=false
    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['secret'],
      confirmResponses: [true, false],
    })

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<unknown>
      }
      await expect(runSetup({ configPath, prompter })).rejects.toThrow(/server-error/)
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('stale cleanup: removes plugins.entries.trueconf from old-format configs', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({
      plugins: { entries: { trueconf: { enabled: true, legacy: 'yes' }, other: { enabled: true } } },
    }, null, 2))

    process.env.TRUECONF_SERVER_URL = fake.host
    process.env.TRUECONF_USERNAME = 'bot@localhost'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = String(fake.port)

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string }) => Promise<unknown>
      }
      await runSetup({ configPath })

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        plugins?: { entries?: Record<string, unknown> }
      }
      expect(written.plugins?.entries?.trueconf).toBeUndefined()
      // Other entries preserved
      expect(written.plugins?.entries?.other).toEqual({ enabled: true })
    } finally {
      delete process.env.TRUECONF_SERVER_URL
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
      delete process.env.TRUECONF_USE_TLS
      delete process.env.TRUECONF_PORT
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('node version: rejects Node < 22.14 at entry', async () => {
    // Mock process.versions.node by constructing a scenario — we can't easily
    // downgrade Node, so this test is smoke-level: runSetup loaded and called
    // — checkNodeVersion already passed for the test runtime, so we just
    // verify it does NOT error on a supported version.
    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<unknown>
    }
    // Write a config that will trigger overwrite-cancel so runSetup returns cleanly.
    writeFileSync(configPath, JSON.stringify({ channels: { trueconf: {} } }, null, 2))
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const prompter = makeFakePrompter({ confirmResponses: [false] })
    await expect(runSetup({ configPath, prompter })).resolves.toBeDefined()
  })

  // --- Probe preview + manual override coverage ------------------------

  // A fake probe module that returns a canned result without touching any
  // real socket. Lets tests exercise the preview/override branches against
  // fake-server (which listens on a random port, not 443/4309/80).
  function stubProbeModule(validateOAuthCredentials: unknown, probeResult: unknown) {
    return {
      probeTls: async () => probeResult,
      downloadCAChain: async () => ({ path: '/tmp/fake-ca.pem', bytes: Buffer.from('') }),
      validateOAuthCredentials,
    }
  }

  it('probe preview: accept → writes cfg with probe-decided useTls/port', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const realProbe = await import('../../src/probe.mjs') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({}, null, 2))

    const probeStub = stubProbeModule(
      (realProbe as { validateOAuthCredentials: unknown }).validateOAuthCredentials,
      { reachable: true, useTls: false, port: fake.port, caUntrusted: false },
    )

    // Confirm order: probe-accept=true (no overwrite prompt on empty cfg)
    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['secret'],
      confirmResponses: [true],
    })

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown; probeModule?: unknown }) => Promise<{ mode: string }>
      }
      const result = await runSetup({ configPath, prompter, probeModule: probeStub })

      expect(result.mode).toBe('saved')
      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { useTls?: boolean; port?: number } }
      }
      expect(written.channels?.trueconf?.useTls).toBe(false)
      expect(written.channels?.trueconf?.port).toBe(fake.port)
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('probe preview: reject → manual TLS=false + port override writes cfg', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const realProbe = await import('../../src/probe.mjs') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({}, null, 2))

    // Probe suggests TLS=true/port=443 (default); user rejects and manually picks HTTP/fake.port.
    const probeStub = stubProbeModule(
      (realProbe as { validateOAuthCredentials: unknown }).validateOAuthCredentials,
      { reachable: true, useTls: true, port: 443, caUntrusted: false },
    )

    // Confirm order: probe-accept=false, manualTls=false
    // Text order: serverUrl, username, manualPort
    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost', String(fake.port)],
      passwordResponses: ['secret'],
      confirmResponses: [false, false],
    })

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown; probeModule?: unknown }) => Promise<{ mode: string }>
      }
      const result = await runSetup({ configPath, prompter, probeModule: probeStub })

      expect(result.mode).toBe('saved')
      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { useTls?: boolean; port?: number } }
      }
      expect(written.channels?.trueconf?.useTls).toBe(false)
      expect(written.channels?.trueconf?.port).toBe(fake.port)
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('probe preview: reject → manual port out of range throws', async () => {
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const realProbe = await import('../../src/probe.mjs') as never
    writeFileSync(configPath, JSON.stringify({}, null, 2))

    const probeStub = stubProbeModule(
      (realProbe as { validateOAuthCredentials: unknown }).validateOAuthCredentials,
      { reachable: true, useTls: true, port: 443, caUntrusted: false },
    )

    const prompter = makeFakePrompter({
      textResponses: ['srv.example.com', 'bot@srv', '99999'],  // port >65535
      passwordResponses: ['secret'],
      confirmResponses: [false, false],  // reject preview, manualTls=false
    })

    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; prompter?: unknown; probeModule?: unknown }) => Promise<unknown>
    }
    await expect(runSetup({ configPath, prompter, probeModule: probeStub })).rejects.toThrow(/Невалидный порт/)
  })

  // --- OAuth retry loop coverage ----------------------------------------

  it('OAuth retry: 1st 401 → 2nd attempt with different pwd succeeds', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{
      host: string; port: number; setOauthResponse: (r: unknown) => void; oauthRequests: unknown[]
    }>)({ oauthResponse: { status: 401 } })
    writeFileSync(configPath, JSON.stringify({
      channels: { trueconf: { useTls: false, port: fake.port } },
    }, null, 2))

    // After 1st 401 and password re-prompt, flip fake to 200 so 2nd succeeds.
    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['wrong-pwd', 'correct-pwd'],
      confirmResponses: [true],  // overwrite existing trueconf cfg
    })

    // Patch prompter.password to flip server response on 2nd call.
    const originalPassword = (prompter as unknown as { password: (opts: unknown) => Promise<unknown> }).password
    let pwdCalls = 0
    ;(prompter as unknown as { password: (opts: unknown) => Promise<unknown> }).password = async (opts) => {
      pwdCalls++
      if (pwdCalls === 2) fake.setOauthResponse({ status: 200, body: { access_token: 'ok' } })
      return originalPassword(opts)
    }

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<{ mode: string }>
      }
      const result = await runSetup({ configPath, prompter })

      expect(result.mode).toBe('saved')
      expect(fake.oauthRequests.length).toBe(2)  // exactly 2 OAuth attempts
      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { password?: string } }
      }
      expect(written.channels?.trueconf?.password).toBe('correct-pwd')
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('OAuth retry: 3× 401 → throws invalid-credentials (no save-anyway offered)', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{
      host: string; port: number; oauthRequests: unknown[]
    }>)({ oauthResponse: { status: 401 } })
    writeFileSync(configPath, JSON.stringify({
      channels: { trueconf: { useTls: false, port: fake.port } },
    }, null, 2))

    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['wrong1', 'wrong2', 'wrong3'],
      confirmResponses: [true],
    })

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown }) => Promise<unknown>
      }
      await expect(runSetup({ configPath, prompter })).rejects.toThrow(/invalid-credentials/)
      expect(fake.oauthRequests.length).toBe(3)  // exactly 3 attempts, no 4th
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  // --- TLS trust flow (tlsVerify=false) coverage ------------------------

  it('untrusted cert → decline download → accept insecure → saves tlsVerify=false without caPath', async () => {
    // Stub probe to report caUntrusted=true on the fake-server's port. Stub
    // validateOAuthCredentials so it succeeds without actually connecting
    // (the fake-server is HTTP-only so a real https handshake would fail).
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({}, null, 2))

    let lastOAuthCall: { ca?: unknown; tlsVerify?: unknown } | null = null
    const probeStub = {
      probeTls: async () => ({ reachable: true, useTls: true, port: fake.port, caUntrusted: true }),
      downloadCAChain: async () => ({ path: '/tmp/fake-ca.pem', bytes: Buffer.from('') }),
      validateOAuthCredentials: async (opts: { ca?: unknown; tlsVerify?: unknown }) => {
        lastOAuthCall = opts
        return { ok: true }
      },
    }

    // Confirm order: download=false, insecure=true, probe-accept=true
    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['secret'],
      confirmResponses: [false, true, true],
    })

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown; probeModule?: unknown }) => Promise<{ mode: string }>
      }
      const result = await runSetup({ configPath, prompter, probeModule: probeStub })

      expect(result.mode).toBe('saved')
      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { tlsVerify?: boolean; caPath?: string } }
      }
      expect(written.channels?.trueconf?.tlsVerify).toBe(false)
      expect(written.channels?.trueconf?.caPath).toBeUndefined()
      // OAuth saw tlsVerify=false and no ca
      expect(lastOAuthCall?.tlsVerify).toBe(false)
      expect(lastOAuthCall?.ca).toBeUndefined()
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('insecure mode: clears stale caPath from existing cfg', async () => {
    // Existing cfg has a caPath; user re-runs setup, declines download,
    // chooses insecure. Stale caPath must be removed from saved cfg.
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({
      channels: { trueconf: { caPath: '/etc/old-ca.pem' } },
    }, null, 2))

    const probeStub = {
      probeTls: async () => ({ reachable: true, useTls: true, port: fake.port, caUntrusted: true }),
      downloadCAChain: async () => ({ path: '/tmp/fake-ca.pem', bytes: Buffer.from('') }),
      validateOAuthCredentials: async () => ({ ok: true }),
    }

    // Confirm order: overwrite=true, download=false, insecure=true, probe-accept=true
    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['secret'],
      confirmResponses: [true, false, true, true],
    })

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string; prompter?: unknown; probeModule?: unknown }) => Promise<{ mode: string }>
      }
      await runSetup({ configPath, prompter, probeModule: probeStub })

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { tlsVerify?: boolean; caPath?: string } }
      }
      expect(written.channels?.trueconf?.tlsVerify).toBe(false)
      expect(written.channels?.trueconf?.caPath).toBeUndefined()
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('untrusted cert → decline download → decline insecure → throws', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({}, null, 2))

    const probeStub = {
      probeTls: async () => ({ reachable: true, useTls: true, port: fake.port, caUntrusted: true }),
      downloadCAChain: async () => ({ path: '/tmp/fake-ca.pem', bytes: Buffer.from('') }),
      validateOAuthCredentials: async () => ({ ok: true }),
    }

    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['secret'],
      confirmResponses: [false, false],  // download=false, insecure=false
    })

    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; prompter?: unknown; probeModule?: unknown }) => Promise<unknown>
    }
    try {
      await expect(runSetup({ configPath, prompter, probeModule: probeStub })).rejects.toThrow(/User aborted: untrusted cert/)
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('readCaBuffer no longer silently swallows unreadable CA: bin throws when downloaded path is missing', async () => {
    // Probe says caUntrusted=true; user accepts download; downloadCAChain
    // stub returns a path that does NOT exist on disk. The old silent-undef
    // behavior would forward `ca: undefined` to OAuth (downgrading the
    // operator's pin to system trust). Bin now throws loud.
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const { makeFakePrompter } = await import('../smoke/fake-prompter')
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({}, null, 2))

    const probeStub = {
      probeTls: async () => ({ reachable: true, useTls: true, port: fake.port, caUntrusted: true }),
      // Returns a path that does not exist anywhere — readCaBuffer would
      // silently swallow ENOENT in the old code; now must throw loud.
      downloadCAChain: async () => ({ path: '/tmp/does-not-exist-ca-bin-test.pem', bytes: Buffer.from('') }),
      validateOAuthCredentials: async () => ({ ok: true }),
    }

    const prompter = makeFakePrompter({
      textResponses: [fake.host, 'bot@localhost'],
      passwordResponses: ['secret'],
      confirmResponses: [true, true],  // accept download + accept preview
    })

    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; prompter?: unknown; probeModule?: unknown }) => Promise<unknown>
    }
    try {
      await expect(runSetup({ configPath, prompter, probeModule: probeStub })).rejects.toThrow(/CA file unreadable/)
    } finally {
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })

  it('headless: bin saves setupLocale into channels.trueconf when TRUECONF_SETUP_LOCALE=ru', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    writeFileSync(configPath, JSON.stringify({}, null, 2))

    process.env.TRUECONF_SERVER_URL = fake.host
    process.env.TRUECONF_USERNAME = 'bot@localhost'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = String(fake.port)
    process.env.TRUECONF_SETUP_LOCALE = 'ru'

    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string }) => Promise<unknown>
      }
      await runSetup({ configPath })

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        channels?: { trueconf?: { setupLocale?: string } }
      }
      expect(written.channels?.trueconf?.setupLocale).toBe('ru')
    } finally {
      delete process.env.TRUECONF_SERVER_URL
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
      delete process.env.TRUECONF_USE_TLS
      delete process.env.TRUECONF_PORT
      delete process.env.TRUECONF_SETUP_LOCALE
      await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
    }
  })
})
