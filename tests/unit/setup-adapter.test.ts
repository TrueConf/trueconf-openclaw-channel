import { describe, it, expect } from 'vitest'
import { trueconfSetupAdapter } from '../../src/setup-shared'

describe('trueconfSetupAdapter', () => {
  it('applyAccountConfig writes minimum-required fields', () => {
    const out = trueconfSetupAdapter.applyAccountConfig({
      cfg: {} as never,
      accountId: 'default',
      input: { serverUrl: 'tc.x', username: 'u', password: 'p' } as never,
    })
    const tc = (out as { channels?: { trueconf?: { serverUrl?: string; username?: string; password?: string; enabled?: boolean } } }).channels?.trueconf
    expect(tc?.serverUrl).toBe('tc.x')
    expect(tc?.username).toBe('u')
    expect(tc?.password).toBe('p')
    expect(tc?.enabled).toBe(true)
  })

  it('applyAccountConfig preserves existing siblings (e.g. dmPolicy)', () => {
    const cfg = { channels: { trueconf: { dmPolicy: 'allowlist', allowFrom: ['x@y.z'] } } } as never
    const out = trueconfSetupAdapter.applyAccountConfig({
      cfg,
      accountId: 'default',
      input: { serverUrl: 'tc.x', username: 'u', password: 'p' } as never,
    })
    const tc = (out as { channels?: { trueconf?: { dmPolicy?: string; allowFrom?: string[] } } }).channels?.trueconf
    expect(tc?.dmPolicy).toBe('allowlist')
    expect(tc?.allowFrom).toEqual(['x@y.z'])
  })

  it('applyAccountConfig drops caPath when tlsVerify === false (mutual exclusion)', () => {
    const out = trueconfSetupAdapter.applyAccountConfig({
      cfg: {} as never,
      accountId: 'default',
      input: { serverUrl: 'tc.x', username: 'u', password: 'p', tlsVerify: false, caPath: '/etc/ca.pem' } as never,
    })
    const tc = (out as { channels?: { trueconf?: { tlsVerify?: boolean; caPath?: string } } }).channels?.trueconf
    expect(tc?.tlsVerify).toBe(false)
    expect(tc?.caPath).toBeUndefined()
  })

  it('applyAccountConfig drops empty optional fields', () => {
    const out = trueconfSetupAdapter.applyAccountConfig({
      cfg: {} as never,
      accountId: 'default',
      input: { serverUrl: 'tc.x', username: 'u', password: 'p', port: undefined, clientId: '' } as never,
    })
    const tc = (out as { channels?: { trueconf?: Record<string, unknown> } }).channels?.trueconf
    expect(tc).not.toHaveProperty('port')
    expect(tc).not.toHaveProperty('clientId')
  })

  it('validateInput returns null when all 3 required fields present', () => {
    const result = trueconfSetupAdapter.validateInput?.({
      cfg: {} as never,
      accountId: 'default',
      input: { serverUrl: 'tc.x', username: 'u', password: 'p' } as never,
    })
    expect(result).toBeNull()
  })

  it('validateInput returns error string when serverUrl missing', () => {
    const result = trueconfSetupAdapter.validateInput?.({
      cfg: {} as never,
      accountId: 'default',
      input: { username: 'u', password: 'p' } as never,
    })
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('validateInput returns error string when password missing', () => {
    const result = trueconfSetupAdapter.validateInput?.({
      cfg: {} as never,
      accountId: 'default',
      input: { serverUrl: 'tc.x', username: 'u' } as never,
    })
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('resolveAccountId returns "default" for nullish accountId', () => {
    const id = trueconfSetupAdapter.resolveAccountId?.({ cfg: {} as never, accountId: undefined })
    expect(id).toBe('default')
  })

  it('applyAccountName returns a valid cfg object', () => {
    const out = trueconfSetupAdapter.applyAccountName?.({
      cfg: { channels: { trueconf: { serverUrl: 'tc.x', username: 'u', password: 'p' } } } as never,
      accountId: 'default',
      name: 'Primary',
    })
    expect(out).toBeDefined()
    expect(typeof out).toBe('object')
  })
})
