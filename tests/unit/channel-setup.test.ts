import { describe, it, expect } from 'vitest'
import { trueconfSetupWizard } from '../../src/channel-setup'

describe('trueconfSetupWizard shape', () => {
  it('exports channel="trueconf"', () => {
    expect(trueconfSetupWizard.channel).toBe('trueconf')
  })

  it('has required wizard sections', () => {
    expect(trueconfSetupWizard.status).toBeDefined()
    expect(trueconfSetupWizard.introNote).toBeDefined()
    expect(trueconfSetupWizard.textInputs).toBeInstanceOf(Array)
    expect(trueconfSetupWizard.textInputs!.length).toBeGreaterThanOrEqual(4)
  })

  it('status.resolveConfigured false for empty cfg', () => {
    const result = trueconfSetupWizard.status.resolveConfigured({ cfg: {} as never })
    expect(result).toBe(false)
  })

  it('status.resolveConfigured true for complete cfg', () => {
    const cfg = {
      channels: { trueconf: {
        serverUrl: 'tc.example.com',
        username: 'bot@tc.example.com',
        password: 'secret',
      } },
    }
    const result = trueconfSetupWizard.status.resolveConfigured({ cfg: cfg as never })
    expect(result).toBe(true)
  })
})

describe('trueconfSetupWizard.textInputs validation', () => {
  const findInput = (key: string) =>
    trueconfSetupWizard.textInputs!.find((i) => (i as { inputKey: string }).inputKey === key)

  it('serverUrl rejects http:// prefix', () => {
    const input = findInput('serverUrl')!
    const result = input.validate!({
      value: 'http://tc.example.com',
      cfg: {} as never, accountId: 'default', credentialValues: {},
    })
    expect(result).toMatch(/without http/i)
  })

  it('serverUrl accepts bare host', () => {
    const input = findInput('serverUrl')!
    const result = input.validate!({
      value: 'tc.example.com',
      cfg: {} as never, accountId: 'default', credentialValues: {},
    })
    expect(result).toBeUndefined()
  })

  it('port rejects non-numeric', () => {
    const input = findInput('port')!
    const result = input.validate!({
      value: 'abc',
      cfg: {} as never, accountId: 'default', credentialValues: {},
    })
    expect(result).toBe('Invalid port')
  })

  it('port rejects out-of-range', () => {
    const input = findInput('port')!
    expect(input.validate!({ value: '99999', cfg: {} as never, accountId: 'default', credentialValues: {} })).toBeDefined()
    expect(input.validate!({ value: '0', cfg: {} as never, accountId: 'default', credentialValues: {} })).toBeDefined()
  })

  it('port accepts empty', () => {
    const input = findInput('port')!
    expect(input.validate!({ value: '', cfg: {} as never, accountId: 'default', credentialValues: {} })).toBeUndefined()
  })
})

describe('trueconfSetupWizard.credentials', () => {
  it('has a password credential', () => {
    expect(trueconfSetupWizard.credentials).toHaveLength(1)
    expect(trueconfSetupWizard.credentials[0].inputKey).toBe('password')
    expect(trueconfSetupWizard.credentials[0].preferredEnvVar).toBe('TRUECONF_PASSWORD')
  })

  it('credentials[0].inspect reports accountConfigured based on cfg', () => {
    const cred = trueconfSetupWizard.credentials[0]
    const empty = cred.inspect({ cfg: {} as never, accountId: 'default' })
    expect(empty.accountConfigured).toBe(false)

    const full = cred.inspect({
      cfg: { channels: { trueconf: { password: 'set' } } } as never,
      accountId: 'default',
    })
    expect(full.accountConfigured).toBe(true)
  })

  it('credentials[0].inspect reports envValue when TRUECONF_PASSWORD set', () => {
    process.env.TRUECONF_PASSWORD = 'env-pw'
    try {
      const cred = trueconfSetupWizard.credentials[0]
      const state = cred.inspect({ cfg: {} as never, accountId: 'default' })
      expect(state.envValue).toBe('env-pw')
    } finally {
      delete process.env.TRUECONF_PASSWORD
    }
  })
})

describe('trueconfSetupWizard.envShortcut', () => {
  it('isAvailable true when all 3 env vars set', () => {
    process.env.TRUECONF_SERVER_URL = 'tc.example.com'
    process.env.TRUECONF_USERNAME = 'bot@tc.example.com'
    process.env.TRUECONF_PASSWORD = 'secret'
    try {
      expect(trueconfSetupWizard.envShortcut!.isAvailable({ cfg: {} as never, accountId: 'default' })).toBe(true)
    } finally {
      delete process.env.TRUECONF_SERVER_URL
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
    }
  })

  it('isAvailable false when any env var missing', () => {
    delete process.env.TRUECONF_SERVER_URL
    process.env.TRUECONF_USERNAME = 'u'
    process.env.TRUECONF_PASSWORD = 'p'
    try {
      expect(trueconfSetupWizard.envShortcut!.isAvailable({ cfg: {} as never, accountId: 'default' })).toBe(false)
    } finally {
      delete process.env.TRUECONF_USERNAME
      delete process.env.TRUECONF_PASSWORD
    }
  })
})
