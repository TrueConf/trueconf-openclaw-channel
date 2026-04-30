// Static-shape tests for the FULL-runtime channelPlugin export.
// channel.ts is the entry point loaded when openclaw runs the gateway
// (`openclaw gateway`); src/setup-entry.ts is the setup-only entry loaded by
// `openclaw onboard` / `channels list` / `plugins install` / `plugins setup`.
// Both surfaces MUST expose the same plugin.config + plugin.setup +
// plugin.setupWizard shape so a future surgical edit dropping a method from
// channel.ts (which does NOT consume createTrueconfPluginBase — kept hand-
// rolled to avoid restructuring outbound/gateway/messaging) is caught here.
//
// Mirrors tests/unit/setup-entry-shape.test.ts but asserts against the
// full-runtime channelPlugin export instead of the setup-entry default export.
import { describe, it, expect } from 'vitest'

describe('channelPlugin (full-runtime entry) shape', () => {
  it('has id "trueconf"', async () => {
    const { channelPlugin } = await import('../../src/channel')
    expect(channelPlugin.id).toBe('trueconf')
  })

  it('has config.listAccountIds callable', async () => {
    const { channelPlugin } = await import('../../src/channel')
    expect(typeof channelPlugin.config.listAccountIds).toBe('function')
  })

  it('has config.defaultAccountId callable', async () => {
    const { channelPlugin } = await import('../../src/channel')
    expect(typeof channelPlugin.config.defaultAccountId).toBe('function')
  })

  it('has config.resolveAccount callable', async () => {
    const { channelPlugin } = await import('../../src/channel')
    expect(typeof channelPlugin.config.resolveAccount).toBe('function')
  })

  it('has config.{isConfigured,isEnabled,describeAccount} callable', async () => {
    const { channelPlugin } = await import('../../src/channel')
    expect(typeof channelPlugin.config.isConfigured).toBe('function')
    expect(typeof channelPlugin.config.isEnabled).toBe('function')
    expect(typeof channelPlugin.config.describeAccount).toBe('function')
  })

  it('has setupWizard object', async () => {
    const { channelPlugin } = await import('../../src/channel')
    expect(typeof channelPlugin.setupWizard).toBe('object')
    expect(channelPlugin.setupWizard).not.toBeNull()
  })

  it('has setup.applyAccountConfig callable', async () => {
    const { channelPlugin } = await import('../../src/channel')
    expect(typeof channelPlugin.setup.applyAccountConfig).toBe('function')
  })

  it('has meta.selectionLabel "TrueConf Server"', async () => {
    const { channelPlugin } = await import('../../src/channel')
    expect(channelPlugin.meta?.selectionLabel).toBe('TrueConf Server')
  })

  it('config.defaultAccountId returns "default" for empty config', async () => {
    const { channelPlugin } = await import('../../src/channel')
    expect(channelPlugin.config.defaultAccountId({})).toBe('default')
  })

  it('config.defaultAccountId returns first account id from headless cfg', async () => {
    const { channelPlugin } = await import('../../src/channel')
    const cfg = { channels: { trueconf: { serverUrl: 'tc.example.com', username: 'bot', password: 'x' } } }
    expect(channelPlugin.config.defaultAccountId(cfg)).toBe('default')
  })

  it('exposes the SAME 6 config method names as createTrueconfPluginBase factory', async () => {
    const { channelPlugin } = await import('../../src/channel')
    const { createTrueconfPluginBase } = await import('../../src/plugin-base')
    const factoryPlugin = createTrueconfPluginBase({
      setupWizard: channelPlugin.setupWizard,
      setup: channelPlugin.setup,
    })
    expect(Object.keys(channelPlugin.config).sort()).toEqual(
      Object.keys(factoryPlugin.config).sort(),
    )
  })

  it('shares the SAME setupWizard / setup references with the factory output', async () => {
    const { channelPlugin } = await import('../../src/channel')
    const { trueconfSetupWizard } = await import('../../src/channel-setup')
    const { trueconfSetupAdapter } = await import('../../src/setup-shared')
    expect(channelPlugin.setupWizard).toBe(trueconfSetupWizard)
    expect(channelPlugin.setup).toBe(trueconfSetupAdapter)
  })
})
