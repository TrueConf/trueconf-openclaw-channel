// Integration test against openclaw 2026.4.21 (sandboxed at /tmp/openclaw-repro/).
//
// Reproduces UX-22's crash path: openclaw 2026.4.21+ onboard calls
// `plugin.config.defaultAccountId?.(cfg) ?? plugin.config.listAccountIds(cfg)[0] ?? "default"`
// (per onboard-channels-*.js:275). Pre-fix, our setup-only entry exposed
// neither `config` nor `setup`, so onboard hit
// `cannot read properties of undefined (reading 'defaultAccountId')` the
// moment the operator picked TrueConf in the channel picker.
//
// Post-fix (Plan 01-02 Task .3), setup-entry wraps createTrueconfPluginBase
// and ships plugin.config + plugin.setup. The same wizard adapter that
// onboard's buildChannelSetupWizardAdapterFromSetupWizard wraps is exercised
// here directly via plugin.setup.{applyAccountConfig, validateInput} +
// plugin.setupWizard.{textInputs, credentials}.
//
// Subprocess-spawning the onboard CLI is interactive (TTY) and not
// deterministic — we exercise the same programmatic surface onboard uses
// internally.
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'

const REPRO_DIR = '/tmp/openclaw-repro'
const sandboxAvailable = existsSync(`${REPRO_DIR}/node_modules/openclaw/package.json`)

describe.skipIf(!sandboxAvailable)('integration: openclaw 2026.4.21 onboard inline-wizard path', () => {
  let plugin: {
    id: string
    setupWizard?: {
      textInputs?: unknown[]
      credentials?: unknown[]
    }
    setup?: {
      applyAccountConfig: (params: { cfg: unknown; accountId: string; input: unknown }) => unknown
      validateInput?: (params: { cfg: unknown; accountId: string; input: unknown }) => string | null
    }
    config?: {
      listAccountIds: (cfg: unknown) => string[]
      defaultAccountId?: (cfg: unknown) => string
      resolveAccount: (cfg: unknown, accountId?: string | null) => unknown
    }
  }

  beforeAll(async () => {
    const mod = await import('../../src/setup-entry')
    plugin = (mod.default as { plugin: typeof plugin }).plugin
  })

  it('plugin.setup.applyAccountConfig writes channels.trueconf with required keys', () => {
    const cfg = plugin.setup?.applyAccountConfig({
      cfg: {},
      accountId: 'default',
      input: { serverUrl: 'tc.x', username: 'u', password: 'p' },
    }) as {
      channels?: { trueconf?: { serverUrl?: string; username?: string; password?: string; enabled?: boolean } }
    }
    expect(cfg.channels?.trueconf?.serverUrl).toBe('tc.x')
    expect(cfg.channels?.trueconf?.username).toBe('u')
    expect(cfg.channels?.trueconf?.password).toBe('p')
    expect(cfg.channels?.trueconf?.enabled).toBe(true)
  })

  it('plugin.setup.validateInput rejects missing required fields', () => {
    const result = plugin.setup?.validateInput?.({
      cfg: {},
      accountId: 'default',
      input: { serverUrl: 'tc.x' },
    })
    expect(typeof result).toBe('string')
    expect(result).toMatch(/username|password/i)
  })

  it('round-trip: applyAccountConfig → config.resolveAccount produces matching account', () => {
    const cfgIn = plugin.setup?.applyAccountConfig({
      cfg: {},
      accountId: 'default',
      input: { serverUrl: 'tc.example.com', username: 'bot@tc.example.com', password: 'secret' },
    })
    const acct = plugin.config?.resolveAccount(cfgIn, 'default') as {
      serverUrl?: string; username?: string; configured?: boolean
    }
    expect(acct?.serverUrl).toBe('tc.example.com')
    expect(acct?.username).toBe('bot@tc.example.com')
    expect(acct?.configured).toBe(true)
  })

  it('plugin.config.defaultAccountId does NOT throw on cfg with empty channels.trueconf (UX-22 root-cause repro)', () => {
    let threw: unknown
    let result: string | undefined
    try {
      result = plugin.config?.defaultAccountId?.({ channels: { trueconf: {} } })
    } catch (e) {
      threw = e
    }
    expect(threw).toBeUndefined()
    expect(result).toBe('default')
  })

  it('plugin.setupWizard has the textInputs + credentials shape the onboard adapter expects', () => {
    expect(Array.isArray(plugin.setupWizard?.textInputs)).toBe(true)
    expect(plugin.setupWizard?.textInputs?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(Array.isArray(plugin.setupWizard?.credentials)).toBe(true)
    expect(plugin.setupWizard?.credentials?.length).toBe(1)
  })
})
