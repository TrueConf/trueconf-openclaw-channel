import { describe, it, expect } from 'vitest'
import { resolveSecret, resolveAccount } from '../../src/config'

describe('resolveSecret', () => {
  it('returns the string as-is for plain string input', () => {
    expect(resolveSecret('plain-password')).toBe('plain-password')
  })

  it('returns undefined for undefined input', () => {
    expect(resolveSecret(undefined)).toBeUndefined()
  })

  it('resolves { useEnv } by reading process.env', () => {
    process.env.TEST_SECRET_RESOLVE = 'from-env'
    try {
      expect(resolveSecret({ useEnv: 'TEST_SECRET_RESOLVE' })).toBe('from-env')
    } finally {
      delete process.env.TEST_SECRET_RESOLVE
    }
  })

  it('returns undefined for { useEnv } referring to unset var', () => {
    delete process.env.NOT_SET_DEFINITELY_123
    expect(resolveSecret({ useEnv: 'NOT_SET_DEFINITELY_123' })).toBeUndefined()
  })

  it('returns undefined for { useEnv } when env value is whitespace only', () => {
    // `export TRUECONF_PASSWORD=$(cat file)` can leave whitespace-only or
    // empty values; treat them as unset so isRawConfigured's length>0 check
    // still flags the account as not-configured instead of silent 401.
    process.env.TEST_WHITESPACE_SECRET = '   \n\t'
    try {
      expect(resolveSecret({ useEnv: 'TEST_WHITESPACE_SECRET' })).toBeUndefined()
    } finally {
      delete process.env.TEST_WHITESPACE_SECRET
    }
  })

  it('trims trailing newline from env value (common with $(cat file))', () => {
    process.env.TEST_TRAILING_NEWLINE_SECRET = 'secret\n'
    try {
      expect(resolveSecret({ useEnv: 'TEST_TRAILING_NEWLINE_SECRET' })).toBe('secret')
    } finally {
      delete process.env.TEST_TRAILING_NEWLINE_SECRET
    }
  })

  it('returns undefined for malformed input', () => {
    expect(resolveSecret({} as never)).toBeUndefined()
    expect(resolveSecret(42 as never)).toBeUndefined()
  })
})

describe('resolveAccount with secret-ref password', () => {
  it('resolves password from env and reports configured=true', () => {
    process.env.TRUECONF_TEST_PW = 'secret'
    try {
      const account = resolveAccount({
        serverUrl: 'tc.example.com',
        username: 'bot@tc.example.com',
        password: { useEnv: 'TRUECONF_TEST_PW' },
      } as never)
      expect(account.configured).toBe(true)
      expect(account.password).toBe('secret')
    } finally {
      delete process.env.TRUECONF_TEST_PW
    }
  })

  it('reports configured=false when env-ref points to unset var', () => {
    delete process.env.NOT_SET_PW
    const account = resolveAccount({
      serverUrl: 'tc.example.com',
      username: 'bot@tc.example.com',
      password: { useEnv: 'NOT_SET_PW' },
    } as never)
    expect(account.configured).toBe(false)
  })

  it('exposes caPath on ResolvedAccount when set on raw config', () => {
    const account = resolveAccount({
      serverUrl: 'tc.example.com',
      username: 'bot@tc.example.com',
      password: 'plain',
      caPath: '/tmp/custom-ca.pem',
    } as never)
    expect(account.caPath).toBe('/tmp/custom-ca.pem')
  })

  it('exposes tlsVerify=false on ResolvedAccount when set on flat config', () => {
    const account = resolveAccount({
      serverUrl: 'tc.example.com',
      username: 'bot@tc.example.com',
      password: 'plain',
      tlsVerify: false,
    } as never)
    expect(account.tlsVerify).toBe(false)
  })

  it('exposes tlsVerify=false on ResolvedAccount for nested accounts', () => {
    const account = resolveAccount({
      accounts: {
        office: {
          serverUrl: 'tc.example.com',
          username: 'bot@tc.example.com',
          password: 'plain',
          tlsVerify: false,
        },
      },
    } as never, 'office')
    expect(account.tlsVerify).toBe(false)
  })

  it('leaves tlsVerify undefined when omitted (default = strict verify)', () => {
    const account = resolveAccount({
      serverUrl: 'tc.example.com',
      username: 'bot@tc.example.com',
      password: 'plain',
    } as never)
    expect(account.tlsVerify).toBeUndefined()
  })

  it('exposes clientId/clientSecret on ResolvedAccount when set on flat config', () => {
    const account = resolveAccount({
      serverUrl: 'tc.example.com',
      username: 'bot@tc.example.com',
      password: 'plain',
      clientId: 'custom_oauth_client',
      clientSecret: 'super-secret',
    } as never)
    expect(account.clientId).toBe('custom_oauth_client')
    expect(account.clientSecret).toBe('super-secret')
  })

  it('exposes clientId/clientSecret for nested accounts', () => {
    const account = resolveAccount(
      {
        accounts: {
          office: {
            serverUrl: 'tc.example.com',
            username: 'bot@tc.example.com',
            password: 'plain',
            clientId: 'office_client',
            clientSecret: 'office_secret',
          },
        },
      } as never,
      'office',
    )
    expect(account.clientId).toBe('office_client')
    expect(account.clientSecret).toBe('office_secret')
  })

  it('leaves clientId/clientSecret undefined when omitted (acquireToken falls back to chat_bot)', () => {
    const account = resolveAccount({
      serverUrl: 'tc.example.com',
      username: 'bot@tc.example.com',
      password: 'plain',
    } as never)
    expect(account.clientId).toBeUndefined()
    expect(account.clientSecret).toBeUndefined()
  })
})
