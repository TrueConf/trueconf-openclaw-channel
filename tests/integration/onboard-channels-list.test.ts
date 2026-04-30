// Integration test against openclaw 2026.4.21 (sandboxed at /tmp/openclaw-repro/).
//
// Reproduces the COMPAT-07 surface: openclaw 2026.4.21+ routes `channels list`
// through the setup-only entry expecting `plugin.config.{listAccountIds,
// defaultAccountId, resolveAccount, ...}`. Pre-fix, our setup-only entry
// returned `{id, meta, setupWizard}` — undefined plugin.config crashed with
// `TypeError: listAccountIds is not a function` (call site in
// helpers-*.js + agents-*.js per upstream 2026.4.21 source).
//
// Post-fix (Plan 01-02 Task .3), setup-entry wraps createTrueconfPluginBase
// → full ChannelPlugin shape ships through the setup-only entry. This test
// pins the call surface so any future regression that drops a config method
// fails CI, not a customer install.
//
// Spawning `npx openclaw channels list` as a subprocess hangs on TTY prompts
// and is brittle. We invoke the same programmatic surface the runtime uses.
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'

const REPRO_DIR = '/tmp/openclaw-repro'
const sandboxAvailable = existsSync(`${REPRO_DIR}/node_modules/openclaw/package.json`)

describe.skipIf(!sandboxAvailable)('integration: openclaw 2026.4.21 channels list path', () => {
  let plugin: {
    id: string
    config?: {
      listAccountIds: (cfg: unknown) => string[]
      defaultAccountId?: (cfg: unknown) => string
      resolveAccount: (cfg: unknown, accountId?: string | null) => unknown
      isConfigured: (account: unknown) => boolean
      isEnabled: (account: unknown) => boolean
      describeAccount: (account: unknown) => unknown
    }
  }

  beforeAll(async () => {
    const mod = await import('../../src/setup-entry')
    plugin = (mod.default as { plugin: typeof plugin }).plugin
  })

  it('plugin.config.listAccountIds returns ["default"] without TypeError', () => {
    const cfg = { channels: { trueconf: { serverUrl: 'tc.x', username: 'u', password: 'p' } } }
    let result: string[] | undefined
    let threw: unknown
    try {
      result = plugin.config?.listAccountIds(cfg)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeUndefined()
    expect(result).toEqual(['default'])
  })

  it('plugin.config.defaultAccountId returns "default" on empty cfg without TypeError', () => {
    let result: string | undefined
    let threw: unknown
    try {
      result = plugin.config?.defaultAccountId?.({})
    } catch (e) {
      threw = e
    }
    expect(threw).toBeUndefined()
    expect(result).toBe('default')
  })

  it('plugin.config.resolveAccount returns serverUrl-bearing record on configured cfg', () => {
    const cfg = { channels: { trueconf: { serverUrl: 'tc.x', username: 'u', password: 'p' } } }
    const acct = plugin.config?.resolveAccount(cfg, 'default') as { serverUrl?: string; configured?: boolean }
    expect(acct?.serverUrl).toBe('tc.x')
    expect(acct?.configured).toBe(true)
  })

  it('plugin.config has all six methods of the 2026.4.21+ contract', () => {
    const cfg = plugin.config as Record<string, unknown> | undefined
    expect(typeof cfg?.listAccountIds).toBe('function')
    expect(typeof cfg?.defaultAccountId).toBe('function')
    expect(typeof cfg?.resolveAccount).toBe('function')
    expect(typeof cfg?.isConfigured).toBe('function')
    expect(typeof cfg?.isEnabled).toBe('function')
    expect(typeof cfg?.describeAccount).toBe('function')
  })
})
