// Static-shape tests for the setup-only entry. openclaw 2026.4.21+ routes
// `channels list` and `onboard` through this entry expecting the FULL
// ChannelPlugin surface (config + setup + setupWizard) — not just
// {id, meta, setupWizard}. These tests are the unit-level guarantee that
// the gap behind COMPAT-07 / UX-22 stays closed.
import { describe, it, expect } from 'vitest'

describe('setup-entry default export shape', () => {
  it('has id "trueconf"', async () => {
    const mod = await import('../../src/setup-entry')
    expect((mod.default as { plugin?: { id?: string } }).plugin?.id).toBe('trueconf')
  })

  it('has config.listAccountIds callable', async () => {
    const mod = await import('../../src/setup-entry')
    const plugin = (mod.default as { plugin?: { config?: { listAccountIds?: unknown } } }).plugin
    expect(typeof plugin?.config?.listAccountIds).toBe('function')
  })

  it('has config.defaultAccountId callable', async () => {
    const mod = await import('../../src/setup-entry')
    const plugin = (mod.default as { plugin?: { config?: { defaultAccountId?: unknown } } }).plugin
    expect(typeof plugin?.config?.defaultAccountId).toBe('function')
  })

  it('has config.resolveAccount callable', async () => {
    const mod = await import('../../src/setup-entry')
    const plugin = (mod.default as { plugin?: { config?: { resolveAccount?: unknown } } }).plugin
    expect(typeof plugin?.config?.resolveAccount).toBe('function')
  })

  it('has config.{isConfigured,isEnabled,describeAccount} callable', async () => {
    const mod = await import('../../src/setup-entry')
    const plugin = (mod.default as { plugin?: { config?: Record<string, unknown> } }).plugin
    expect(typeof plugin?.config?.isConfigured).toBe('function')
    expect(typeof plugin?.config?.isEnabled).toBe('function')
    expect(typeof plugin?.config?.describeAccount).toBe('function')
  })

  it('has setupWizard object', async () => {
    const mod = await import('../../src/setup-entry')
    const plugin = (mod.default as { plugin?: { setupWizard?: unknown } }).plugin
    expect(typeof plugin?.setupWizard).toBe('object')
    expect(plugin?.setupWizard).not.toBeNull()
  })

  it('has setup.applyAccountConfig callable', async () => {
    const mod = await import('../../src/setup-entry')
    const plugin = (mod.default as { plugin?: { setup?: { applyAccountConfig?: unknown } } }).plugin
    expect(typeof plugin?.setup?.applyAccountConfig).toBe('function')
  })

  it('has meta.selectionLabel "TrueConf Server"', async () => {
    const mod = await import('../../src/setup-entry')
    const plugin = (mod.default as { plugin?: { meta?: { selectionLabel?: string } } }).plugin
    expect(plugin?.meta?.selectionLabel).toBe('TrueConf Server')
  })

  it('config.listAccountIds returns ["default"] when called via the entry surface', async () => {
    const mod = await import('../../src/setup-entry')
    const plugin = (mod.default as { plugin?: { config?: { listAccountIds?: (cfg: unknown) => string[] } } }).plugin
    const result = plugin?.config?.listAccountIds?.({ channels: { trueconf: { serverUrl: 'x', username: 'y', password: 'z' } } })
    expect(result).toEqual(['default'])
  })
})
