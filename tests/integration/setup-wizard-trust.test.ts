import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startTlsFixtureServer } from '../unit/__helpers__/tls-server.mjs'
import { makeFakePrompter } from '../smoke/fake-prompter'

const FIXTURES = join(process.cwd(), 'tests', '__fixtures__')

// vi.mock is hoisted above static imports — but `channel-setup` (which imports
// from `probe.mjs`) MUST be loaded AFTER the mock is applied. Use dynamic import
// at top-level to force that ordering.
vi.mock('../../src/probe.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/probe.mjs')>()
  return {
    ...actual,                          // keep real parseCertFromPem, probeTls, validateCaAgainstServer
    validateOAuthCredentials: vi.fn(),  // capture OAuth args incl. `ca`
    downloadCAChain: vi.fn(),           // stubbed to a tmpdir path per-test
  }
})

// Dynamic import after vi.mock is applied.
const { interactiveFinalize, runHeadlessFinalize } = await import('../../src/channel-setup')
const probe = await import('../../src/probe.mjs')

type OAuthArgs = {
  serverUrl: string
  username: string
  password: string
  useTls?: boolean
  port?: number
  ca?: Uint8Array
}
type OAuthResult = { ok: true } | { ok: false; category: string; error: string }

const oauth = () =>
  probe.validateOAuthCredentials as unknown as ReturnType<
    typeof vi.fn<[OAuthArgs], Promise<OAuthResult>>
  >
const download = () =>
  probe.downloadCAChain as unknown as ReturnType<
    typeof vi.fn<[{ host: string; port: number }], Promise<string>>
  >

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    channels: {
      trueconf: {
        serverUrl: '127.0.0.1',
        username: 'bot',
        useTls: undefined,
        ...overrides,
      },
    },
  }
}

let tmpCaDir: string
// File-level env reset — without this a TRUECONF_* leaked by a prior worker
// run (or a missed afterEach) would silently change which trust path fires.
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('TRUECONF_')) delete process.env[k]
  }
  oauth().mockReset()
  oauth().mockResolvedValue({ ok: true })
  tmpCaDir = mkdtempSync(join(tmpdir(), 'trust-test-'))
  download().mockReset()
  download().mockImplementation(async () => {
    const p = join(tmpCaDir, 'trueconf-ca.pem')
    writeFileSync(p, readFileSync(join(FIXTURES, 'ca-valid.pem')))
    return p
  })
})

describe('interactiveFinalize — env TRUECONF_CA_PATH path', () => {
  let server: Awaited<ReturnType<typeof startTlsFixtureServer>>
  beforeEach(async () => { server = await startTlsFixtureServer('ca-valid') })
  afterEach(async () => {
    delete process.env.TRUECONF_CA_PATH
    await server.close()
  })

  it('happy path: env var points to valid CA → caPath saved, OAuth receives those bytes', async () => {
    process.env.TRUECONF_CA_PATH = join(FIXTURES, 'ca-valid.pem')
    const cfg = makeCfg({ port: server.port })
    const result = await interactiveFinalize({
      cfg,
      prompter: makeFakePrompter({}),
      credentialValues: { password: 'secret' },
      accountId: 'default',
      forceAllowFrom: false,
    })
    expect((result.cfg as any).channels.trueconf.caPath).toBe(join(FIXTURES, 'ca-valid.pem'))
    const args = oauth().mock.calls[0][0]
    expect(args.ca).toBeTruthy()
    expect(Buffer.from(args.ca!).equals(readFileSync(join(FIXTURES, 'ca-valid.pem')))).toBe(true)
  })

  it('env var points to non-PEM → aborts with DER conversion hint', async () => {
    process.env.TRUECONF_CA_PATH = join(FIXTURES, 'gen-fixtures.sh')
    const cfg = makeCfg({ port: server.port })
    await expect(interactiveFinalize({
      cfg, prompter: makeFakePrompter({}), credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })).rejects.toThrow(/не PEM.*openssl x509/)
  })

  it('env var points to wrong CA → aborts with issuer detail', async () => {
    process.env.TRUECONF_CA_PATH = join(FIXTURES, 'ca-other.pem')
    const cfg = makeCfg({ port: server.port })
    await expect(interactiveFinalize({
      cfg, prompter: makeFakePrompter({}), credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })).rejects.toThrow(/не валидирует этот сервер/)
  })

  it('env var points to empty file → aborts with not-PEM hint', async () => {
    const emptyPath = join(tmpCaDir, 'empty.pem')
    writeFileSync(emptyPath, '')
    process.env.TRUECONF_CA_PATH = emptyPath
    const cfg = makeCfg({ port: server.port })
    await expect(interactiveFinalize({
      cfg, prompter: makeFakePrompter({}), credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })).rejects.toThrow(/не PEM/)
  })
})

describe('interactiveFinalize — configured caPath missing', () => {
  let server: Awaited<ReturnType<typeof startTlsFixtureServer>>
  beforeEach(async () => { server = await startTlsFixtureServer('ca-valid') })
  afterEach(async () => { await server.close() })

  it('config points to non-existent file → banner + re-tofu choice calls downloadCAChain', async () => {
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: '/tmp/definitely-does-not-exist.pem' })
    const prompter = makeFakePrompter({ selectResponses: ['re-tofu'] })
    const result = await interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })
    expect((result.cfg as any).channels.trueconf.caPath).toBeTruthy()
    expect((result.cfg as any).channels.trueconf.caPath).not.toBe('/tmp/definitely-does-not-exist.pem')
    expect(download()).toHaveBeenCalledTimes(1)
  })

  it('config points to non-existent file → user picks abort → throws', async () => {
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: '/tmp/nope.pem' })
    const prompter = makeFakePrompter({ selectResponses: ['abort'] })
    await expect(interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })).rejects.toThrow(/User aborted.*configured caPath missing/)
  })
})

describe('interactiveFinalize — mismatch vs silent happy', () => {
  let server: Awaited<ReturnType<typeof startTlsFixtureServer>>
  beforeEach(async () => { server = await startTlsFixtureServer('ca-valid') })
  afterEach(async () => { await server.close() })

  it('silent happy: stored CA validates server → caPath preserved, no prompts', async () => {
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: join(FIXTURES, 'ca-valid.pem') })
    const result = await interactiveFinalize({
      cfg, prompter: makeFakePrompter({}), credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })
    expect((result.cfg as any).channels.trueconf.caPath).toBe(join(FIXTURES, 'ca-valid.pem'))
    expect(download()).not.toHaveBeenCalled()
  })

  it('mismatch: stored CA does not validate → banner → accept-new → chain rewritten', async () => {
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: join(FIXTURES, 'ca-other.pem') })
    const prompter = makeFakePrompter({ selectResponses: ['accept-new'] })
    const result = await interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })
    expect((result.cfg as any).channels.trueconf.caPath).toContain('trueconf-ca.pem')
    expect((result.cfg as any).channels.trueconf.caPath).not.toBe(join(FIXTURES, 'ca-other.pem'))
    expect(download()).toHaveBeenCalledTimes(1)
  })

  it('mismatch → abort → throws', async () => {
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: join(FIXTURES, 'ca-other.pem') })
    const prompter = makeFakePrompter({ selectResponses: ['abort'] })
    await expect(interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })).rejects.toThrow(/trust mismatch/)
  })

  it('mismatch → use-file → valid PEM path → caPath set to user file', async () => {
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: join(FIXTURES, 'ca-other.pem') })
    const prompter = makeFakePrompter({
      selectResponses: ['use-file'],
      textResponses: [join(FIXTURES, 'ca-valid.pem')],
    })
    const result = await interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })
    expect((result.cfg as any).channels.trueconf.caPath).toBe(join(FIXTURES, 'ca-valid.pem'))
    expect(download()).not.toHaveBeenCalled()
  })

  it('rotation mid-flow (accept-new): prompter rejects → throws', async () => {
    // probe sees ca-valid server but download mocked to write ca-other →
    // fingerprint mismatch between banner (ca-valid) and download (ca-other).
    download().mockImplementationOnce(async () => {
      const p = join(tmpCaDir, 'rotated.pem')
      writeFileSync(p, readFileSync(join(FIXTURES, 'ca-other.pem')))
      return p
    })
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: join(FIXTURES, 'ca-other.pem') })
    const prompter = makeFakePrompter({
      selectResponses: ['accept-new'],
      confirmResponses: [false], // user declines the rotation
    })
    await expect(interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })).rejects.toThrow(/rotation detected mid-flow.*declined/)
  })

  it('rotation mid-flow (accept-new): prompter confirms → new cert pinned', async () => {
    download().mockImplementationOnce(async () => {
      const p = join(tmpCaDir, 'rotated.pem')
      writeFileSync(p, readFileSync(join(FIXTURES, 'ca-other.pem')))
      return p
    })
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: join(FIXTURES, 'ca-other.pem') })
    const prompter = makeFakePrompter({
      selectResponses: ['accept-new'],
      confirmResponses: [true], // user accepts the rotation
    })
    const result = await interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })
    expect((result.cfg as any).channels.trueconf.caPath).toContain('rotated.pem')
  })

  it('use-file with empty input (prompter cancelled) → throws cancelled', async () => {
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: join(FIXTURES, 'ca-other.pem') })
    const prompter = makeFakePrompter({
      selectResponses: ['use-file'],
      textResponses: [''], // empty = cancelled
    })
    await expect(interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })).rejects.toThrow(/cancelled.*empty path/)
  })

  it('use-file with 3 bad inputs → throws with accumulated reasons', async () => {
    const cfg = makeCfg({ port: server.port, useTls: true, caPath: join(FIXTURES, 'ca-other.pem') })
    const prompter = makeFakePrompter({
      selectResponses: ['use-file'],
      textResponses: [
        '/tmp/definitely-does-not-exist-trust-fix.pem',
        join(FIXTURES, 'gen-fixtures.sh'),
        join(FIXTURES, 'ca-other.pem'),
      ],
    })
    await expect(interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })).rejects.toThrow(/CA file input failed 3 times.*does-not-exist.*gen-fixtures\.sh.*не PEM.*ca-other\.pem.*chain mismatch/s)
  })
})

describe('interactiveFinalize — fresh TOFU', () => {
  let server: Awaited<ReturnType<typeof startTlsFixtureServer>>
  beforeEach(async () => { server = await startTlsFixtureServer('ca-valid') })
  afterEach(async () => { await server.close() })

  it('no existing caPath, untrusted cert → accept → chain downloaded and saved', async () => {
    const cfg = makeCfg({ port: server.port, useTls: true })
    const prompter = makeFakePrompter({ selectResponses: ['accept'] })
    const result = await interactiveFinalize({
      cfg, prompter, credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })
    expect((result.cfg as any).channels.trueconf.caPath).toContain('trueconf-ca.pem')
    expect(download()).toHaveBeenCalledTimes(1)
  })
})

describe('interactiveFinalize — TOCTOU protection', () => {
  let server: Awaited<ReturnType<typeof startTlsFixtureServer>>
  beforeEach(async () => { server = await startTlsFixtureServer('ca-valid') })
  afterEach(async () => {
    delete process.env.TRUECONF_CA_PATH
    await server.close()
  })

  it('OAuth receives the same bytes the wizard validated in-process', async () => {
    const mutablePath = join(tmpCaDir, 'user-ca.pem')
    const validBytes = readFileSync(join(FIXTURES, 'ca-valid.pem'))
    writeFileSync(mutablePath, validBytes)

    oauth().mockImplementationOnce(async () => {
      writeFileSync(mutablePath, readFileSync(join(FIXTURES, 'ca-other.pem')))
      return { ok: true }
    })

    process.env.TRUECONF_CA_PATH = mutablePath
    const cfg = makeCfg({ port: server.port })
    await interactiveFinalize({
      cfg, prompter: makeFakePrompter({}), credentialValues: { password: 'x' },
      accountId: 'default', forceAllowFrom: false,
    })

    const args = oauth().mock.calls[0][0]
    expect(args.ca).toBeTruthy()
    expect(Buffer.from(args.ca!).equals(validBytes)).toBe(true)
    expect(readFileSync(mutablePath).equals(validBytes)).toBe(false)
  })

  // TODO: vitest (v4) cannot spy on `node:fs` ESM namespace exports
  // (`Cannot redefine property: readFileSync`). The primary TOCTOU check above
  // already covers the in-memory byte equality invariant; this test would only
  // add a per-path read-count assertion. Revisit when vitest exposes a
  // module-proxy or when we move fs I/O through an injectable seam.
  it.skip('does not re-read caPath between validation and OAuth', async () => {
    process.env.TRUECONF_CA_PATH = join(FIXTURES, 'ca-valid.pem')
    const fs = await import('node:fs')
    const spy = vi.spyOn(fs, 'readFileSync')

    try {
      const cfg = makeCfg({ port: server.port })
      await interactiveFinalize({
        cfg, prompter: makeFakePrompter({}), credentialValues: { password: 'x' },
        accountId: 'default', forceAllowFrom: false,
      })
      const reads = spy.mock.calls.filter((c) => String(c[0]) === join(FIXTURES, 'ca-valid.pem'))
      expect(reads.length).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('runHeadlessFinalize — trust paths', () => {
  let server: Awaited<ReturnType<typeof startTlsFixtureServer>>
  beforeEach(async () => { server = await startTlsFixtureServer('ca-valid') })
  afterEach(async () => {
    for (const k of ['TRUECONF_SERVER_URL','TRUECONF_USERNAME','TRUECONF_PASSWORD','TRUECONF_USE_TLS','TRUECONF_PORT','TRUECONF_CA_PATH','TRUECONF_ACCEPT_UNTRUSTED_CA']) {
      delete process.env[k]
    }
    await server.close()
  })

  function baseEnv() {
    process.env.TRUECONF_SERVER_URL = '127.0.0.1'
    process.env.TRUECONF_USERNAME = 'bot'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_USE_TLS = 'true'
    process.env.TRUECONF_PORT = String(server.port)
  }

  it('env TRUECONF_CA_PATH happy → caPath saved, OAuth gets those bytes', async () => {
    baseEnv()
    process.env.TRUECONF_CA_PATH = join(FIXTURES, 'ca-valid.pem')
    const next = await runHeadlessFinalize({} as never)
    expect((next as any).channels.trueconf.caPath).toBe(join(FIXTURES, 'ca-valid.pem'))
    const args = oauth().mock.calls[0][0]
    expect(Buffer.from(args.ca!).equals(readFileSync(join(FIXTURES, 'ca-valid.pem')))).toBe(true)
  })

  it('env TRUECONF_CA_PATH not validating → fatal abort', async () => {
    baseEnv()
    process.env.TRUECONF_CA_PATH = join(FIXTURES, 'ca-other.pem')
    await expect(runHeadlessFinalize({} as never)).rejects.toThrow(/TRUECONF_CA_PATH=.*не валидирует/)
  })

  it('configured caPath missing → fatal abort (no interactive recovery)', async () => {
    baseEnv()
    const cfg = { channels: { trueconf: { caPath: '/tmp/nope-headless.pem' } } }
    await expect(runHeadlessFinalize(cfg as never)).rejects.toThrow(/not readable/i)
  })

  it('configured caPath mismatches server → fatal abort', async () => {
    baseEnv()
    const cfg = { channels: { trueconf: { caPath: join(FIXTURES, 'ca-other.pem') } } }
    await expect(runHeadlessFinalize(cfg as never)).rejects.toThrow(/no longer validates/i)
  })

  it('configured caPath silent happy → caPath preserved', async () => {
    baseEnv()
    const cfg = { channels: { trueconf: { caPath: join(FIXTURES, 'ca-valid.pem') } } }
    const next = await runHeadlessFinalize(cfg as never)
    expect((next as any).channels.trueconf.caPath).toBe(join(FIXTURES, 'ca-valid.pem'))
    const args = oauth().mock.calls[0][0]
    expect(Buffer.from(args.ca!).equals(readFileSync(join(FIXTURES, 'ca-valid.pem')))).toBe(true)
  })

  // The TRUECONF_ACCEPT_UNTRUSTED_CA gate lives behind the raw-probe branch,
  // which only fires when useTls is NOT explicitly set (baseEnv() sets it).
  function envForRawProbe() {
    process.env.TRUECONF_SERVER_URL = '127.0.0.1'
    process.env.TRUECONF_USERNAME = 'bot'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_PORT = String(server.port)
    // deliberately NOT setting TRUECONF_USE_TLS — we want the probe to decide.
  }

  it('untrusted cert + TRUECONF_ACCEPT_UNTRUSTED_CA=true → auto-downloads chain', async () => {
    envForRawProbe()
    process.env.TRUECONF_ACCEPT_UNTRUSTED_CA = 'true'
    const next = await runHeadlessFinalize({} as never)
    expect((next as any).channels.trueconf.caPath).toBeTruthy()
    expect(download()).toHaveBeenCalledTimes(1)
    const args = oauth().mock.calls[0][0]
    expect(args.ca).toBeTruthy()
  })

  it('untrusted cert without TRUECONF_ACCEPT_UNTRUSTED_CA → fatal abort', async () => {
    envForRawProbe()
    await expect(runHeadlessFinalize({} as never)).rejects.toThrow(/TRUECONF_ACCEPT_UNTRUSTED_CA/)
    expect(download()).not.toHaveBeenCalled()
  })

  it('headless rotation mid-flow without TRUECONF_ACCEPT_ROTATED_CERT → fatal abort', async () => {
    envForRawProbe()
    process.env.TRUECONF_ACCEPT_UNTRUSTED_CA = 'true'
    download().mockImplementationOnce(async () => {
      const p = join(tmpCaDir, 'rotated.pem')
      writeFileSync(p, readFileSync(join(FIXTURES, 'ca-other.pem')))
      return p
    })
    await expect(runHeadlessFinalize({} as never)).rejects.toThrow(/rotation detected.*TRUECONF_ACCEPT_ROTATED_CERT/)
  })

  it('headless rotation mid-flow with TRUECONF_ACCEPT_ROTATED_CERT=true → proceeds', async () => {
    envForRawProbe()
    process.env.TRUECONF_ACCEPT_UNTRUSTED_CA = 'true'
    process.env.TRUECONF_ACCEPT_ROTATED_CERT = 'true'
    download().mockImplementationOnce(async () => {
      const p = join(tmpCaDir, 'rotated.pem')
      writeFileSync(p, readFileSync(join(FIXTURES, 'ca-other.pem')))
      return p
    })
    const next = await runHeadlessFinalize({} as never)
    expect((next as any).channels.trueconf.caPath).toContain('rotated.pem')
  })
})
