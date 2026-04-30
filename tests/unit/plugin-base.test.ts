import { describe, it, expect } from 'vitest'
import type { ChannelSetupWizard, ChannelSetupAdapter } from 'openclaw/plugin-sdk/setup'
import { createTrueconfPluginBase } from '../../src/plugin-base'

const stubWizard = { channel: 'trueconf' } as unknown as ChannelSetupWizard
const stubSetup: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg }) => cfg,
}

describe('createTrueconfPluginBase', () => {
  it('exposes id="trueconf"', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    expect(p.id).toBe('trueconf')
  })

  it('exposes meta with selectionLabel "TrueConf Server"', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    expect(p.meta?.label).toBe('TrueConf')
    expect(p.meta?.selectionLabel).toBe('TrueConf Server')
    expect(p.meta?.order).toBe(80)
    expect(p.meta?.aliases).toContain('tc')
  })

  it('exposes config.listAccountIds returning ["default"] for top-level cfg', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    const cfg = { channels: { trueconf: { serverUrl: 'tc.x', username: 'u', password: 'p' } } }
    expect(p.config?.listAccountIds(cfg)).toEqual(['default'])
  })

  it('exposes config.defaultAccountId returning "default" on empty cfg', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    expect(p.config?.defaultAccountId?.({})).toBe('default')
  })

  it('exposes config.defaultAccountId returning first key of multi-account cfg', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    const cfg = {
      channels: {
        trueconf: {
          accounts: {
            primary: { serverUrl: 'a', username: 'b', password: 'c' },
            secondary: { serverUrl: 'd', username: 'e', password: 'f' },
          },
        },
      },
    }
    expect(p.config?.defaultAccountId?.(cfg)).toBe('primary')
  })

  it('exposes config.resolveAccount returning ResolvedAccount', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    const cfg = { channels: { trueconf: { serverUrl: 'tc.x', username: 'u', password: 'p' } } }
    const acct = p.config?.resolveAccount(cfg, 'default')
    expect(acct?.serverUrl).toBe('tc.x')
    expect(acct?.username).toBe('u')
    expect(acct?.configured).toBe(true)
    expect(acct?.enabled).toBe(true)
  })

  it('exposes config.isConfigured / config.isEnabled / config.describeAccount', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    const fakeAccount = { accountId: 'default', configured: true, enabled: true }
    expect(p.config?.isConfigured(fakeAccount)).toBe(true)
    expect(p.config?.isEnabled(fakeAccount)).toBe(true)
    const desc = p.config?.describeAccount(fakeAccount)
    expect(desc?.accountId).toBe('default')
  })

  it('propagates setupWizard from the params unchanged', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    expect(p.setupWizard).toBe(stubWizard)
  })

  it('propagates setup adapter from the params unchanged', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    expect(p.setup).toBe(stubSetup)
  })

  it('exposes capabilities { chatTypes: ["direct","group"], media: true }', () => {
    const p = createTrueconfPluginBase({ setupWizard: stubWizard, setup: stubSetup })
    expect(p.capabilities?.chatTypes).toContain('direct')
    expect(p.capabilities?.chatTypes).toContain('group')
    expect(p.capabilities?.media).toBe(true)
  })
})
