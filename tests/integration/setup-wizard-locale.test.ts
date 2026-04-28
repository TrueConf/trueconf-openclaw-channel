import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakePrompter } from '../smoke/fake-prompter'

// Mirror setup-wizard-trust.test.ts mocking pattern: stub probe + OAuth so
// these tests don't open real sockets, and exercise locale resolution paths.
vi.mock('../../src/probe.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/probe.mjs')>()
  return {
    ...actual,
    probeTls: vi.fn(),
    validateOAuthCredentials: vi.fn(),
    downloadCAChain: vi.fn(),
  }
})

const { interactiveFinalize, runHeadlessFinalize } = await import('../../src/channel-setup')
const probe = await import('../../src/probe.mjs')

type ProbeResult =
  | { reachable: false; error?: string }
  | { reachable: true; useTls: boolean; port: number; caUntrusted: boolean; cert?: unknown }
type OAuthArgs = {
  serverUrl: string
  username: string
  password: string
  useTls?: boolean
  port?: number
  ca?: Uint8Array
}
type OAuthResult = { ok: true } | { ok: false; category: string; error: string }

const probeMock = () =>
  probe.probeTls as unknown as ReturnType<
    typeof vi.fn<[{ host: string; port?: number }], Promise<ProbeResult>>
  >
const oauth = () =>
  probe.validateOAuthCredentials as unknown as ReturnType<
    typeof vi.fn<[OAuthArgs], Promise<OAuthResult>>
  >

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    channels: {
      trueconf: {
        serverUrl: '127.0.0.1',
        username: 'bot',
        useTls: false,
        port: 4309,
        ...overrides,
      },
    },
  }
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('TRUECONF_')) delete process.env[k]
  }
  oauth().mockReset()
  oauth().mockResolvedValue({ ok: true })
  probeMock().mockReset()
  probeMock().mockResolvedValue({
    reachable: true,
    useTls: false,
    port: 4309,
    caUntrusted: false,
  })
})

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('TRUECONF_')) delete process.env[k]
  }
})

describe('interactiveFinalize — locale resolution', () => {
  it('first-run prompts for language; saves channels.trueconf.setupLocale', async () => {
    const cfg = makeCfg()
    const prompter = makeFakePrompter({ selectResponses: ['en'] })
    const result = await interactiveFinalize({
      cfg: cfg as never,
      prompter,
      credentialValues: { password: 'x' },
      accountId: 'default',
      forceAllowFrom: false,
    })
    expect((result.cfg as never as { channels: { trueconf: { setupLocale?: string } } })
      .channels.trueconf.setupLocale).toBe('en')
  })

  it('does not re-prompt when cfg already has setupLocale', async () => {
    const cfg = makeCfg({ setupLocale: 'ru' })
    let languagePromptShown = false
    const basePrompter = makeFakePrompter({}) as unknown as {
      select: (opts: { message: string; options: unknown[] }) => Promise<unknown>
    }
    const originalSelect = basePrompter.select.bind(basePrompter)
    basePrompter.select = async (opts) => {
      if (opts.message.match(/Language|Язык/)) languagePromptShown = true
      return originalSelect(opts)
    }
    await interactiveFinalize({
      cfg: cfg as never,
      prompter: basePrompter as never,
      credentialValues: { password: 'x' },
      accountId: 'default',
      forceAllowFrom: false,
    })
    expect(languagePromptShown).toBe(false)
  })

  it('TRUECONF_SETUP_LOCALE=fr fails fast in interactive', async () => {
    process.env.TRUECONF_SETUP_LOCALE = 'fr'
    const cfg = makeCfg()
    await expect(interactiveFinalize({
      cfg: cfg as never,
      prompter: makeFakePrompter({}),
      credentialValues: { password: 'x' },
      accountId: 'default',
      forceAllowFrom: false,
    })).rejects.toThrow(/TRUECONF_SETUP_LOCALE.*'en' or 'ru'/)
  })
})

describe('runHeadlessFinalize — locale resolution', () => {
  function baseEnv() {
    process.env.TRUECONF_SERVER_URL = '127.0.0.1'
    process.env.TRUECONF_USERNAME = 'bot'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = '4309'
  }

  it('TRUECONF_SETUP_LOCALE=ru wins over cfg en in headless', async () => {
    baseEnv()
    process.env.TRUECONF_SETUP_LOCALE = 'ru'
    const cfg = makeCfg({ setupLocale: 'en' })
    const next = await runHeadlessFinalize(cfg as never)
    expect((next as never as { channels: { trueconf: { setupLocale?: string } } })
      .channels.trueconf.setupLocale).toBe('ru')
  })

  it('TRUECONF_SETUP_LOCALE=fr fails fast in headless', async () => {
    baseEnv()
    process.env.TRUECONF_SETUP_LOCALE = 'fr'
    await expect(runHeadlessFinalize({} as never)).rejects.toThrow(/TRUECONF_SETUP_LOCALE.*'en' or 'ru'/)
  })

  it('headless defaults to en when neither env nor cfg set setupLocale', async () => {
    baseEnv()
    const next = await runHeadlessFinalize({} as never)
    expect((next as never as { channels: { trueconf: { setupLocale?: string } } })
      .channels.trueconf.setupLocale).toBe('en')
  })
})
