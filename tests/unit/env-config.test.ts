import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PUBLIC_ENV_CONTRACT,
  readSetupLocale,
  readServerUrl,
  readUsername,
  readPassword,
  readPasswordRaw,
  readUseTls,
  readPort,
  readCaPath,
  readTlsVerify,
  readAcceptUntrustedCa,
  readAcceptRotatedCert,
  hasSetupShortcut,
  readHeartbeatIntervalMs,
  readHeartbeatPongTimeoutMs,
  readOauthTimeoutMs,
  readWsHandshakeTimeoutMs,
  readOauthFailLimit,
  readDnsFailLimit,
} from '../../src/env-config.js'

const ALL_TRUECONF_VARS = [
  ...PUBLIC_ENV_CONTRACT.setup,
  ...PUBLIC_ENV_CONTRACT.runtime,
] as const

function clearAllTrueConfEnv(): void {
  for (const name of ALL_TRUECONF_VARS) {
    delete process.env[name]
  }
}

beforeEach(() => clearAllTrueConfEnv())
afterEach(() => clearAllTrueConfEnv())

describe('env-config public contract', () => {
  it('setup contract lists exactly the 10 wizard env vars', () => {
    expect(PUBLIC_ENV_CONTRACT.setup).toEqual([
      'TRUECONF_SETUP_LOCALE',
      'TRUECONF_SERVER_URL',
      'TRUECONF_USERNAME',
      'TRUECONF_PASSWORD',
      'TRUECONF_USE_TLS',
      'TRUECONF_PORT',
      'TRUECONF_CA_PATH',
      'TRUECONF_TLS_VERIFY',
      'TRUECONF_ACCEPT_UNTRUSTED_CA',
      'TRUECONF_ACCEPT_ROTATED_CERT',
    ])
  })

  it('runtime contract lists exactly the 6 tunable env vars', () => {
    expect(PUBLIC_ENV_CONTRACT.runtime).toEqual([
      'TRUECONF_HEARTBEAT_INTERVAL_MS',
      'TRUECONF_HEARTBEAT_PONG_TIMEOUT_MS',
      'TRUECONF_OAUTH_TIMEOUT_MS',
      'TRUECONF_WS_HANDSHAKE_TIMEOUT_MS',
      'TRUECONF_OAUTH_FAIL_LIMIT',
      'TRUECONF_DNS_FAIL_LIMIT',
    ])
  })

  it('all 17 readers (10 setup + readPasswordRaw twin + 6 runtime) and hasSetupShortcut are exported as functions', () => {
    for (const fn of [
      readSetupLocale, readServerUrl, readUsername, readPassword, readPasswordRaw,
      readUseTls, readPort, readCaPath, readTlsVerify,
      readAcceptUntrustedCa, readAcceptRotatedCert,
      readHeartbeatIntervalMs, readHeartbeatPongTimeoutMs,
      readOauthTimeoutMs, readWsHandshakeTimeoutMs,
      readOauthFailLimit, readDnsFailLimit,
      hasSetupShortcut,
    ]) {
      expect(typeof fn).toBe('function')
    }
  })
})

describe('env-config readSetupLocale', () => {
  it('returns null when unset', () => {
    expect(readSetupLocale()).toBeNull()
  })
  it('returns en/ru when valid', () => {
    process.env.TRUECONF_SETUP_LOCALE = 'en'
    expect(readSetupLocale()).toBe('en')
    process.env.TRUECONF_SETUP_LOCALE = 'ru'
    expect(readSetupLocale()).toBe('ru')
  })
  it('throws on invalid value (i18n key locale.invalidEnv)', () => {
    process.env.TRUECONF_SETUP_LOCALE = 'xx'
    expect(() => readSetupLocale()).toThrow(/xx/)
  })
})

describe('env-config readServerUrl / readUsername', () => {
  it('returns undefined when unset', () => {
    expect(readServerUrl()).toBeUndefined()
    expect(readUsername()).toBeUndefined()
  })
  it('returns trimmed value when set', () => {
    process.env.TRUECONF_SERVER_URL = '  tc.example.com  '
    process.env.TRUECONF_USERNAME = '  bot  '
    expect(readServerUrl()).toBe('tc.example.com')
    expect(readUsername()).toBe('bot')
  })
  it('returns undefined when whitespace-only', () => {
    process.env.TRUECONF_SERVER_URL = '   '
    process.env.TRUECONF_USERNAME = '\t\n '
    expect(readServerUrl()).toBeUndefined()
    expect(readUsername()).toBeUndefined()
  })
})

describe('env-config readPassword vs readPasswordRaw', () => {
  it('readPassword trims whitespace; readPasswordRaw preserves it', () => {
    process.env.TRUECONF_PASSWORD = '  hunter2  '
    expect(readPassword()).toBe('hunter2')
    expect(readPasswordRaw()).toBe('  hunter2  ')
  })
  it('readPassword collapses whitespace-only to undefined; readPasswordRaw preserves the literal', () => {
    process.env.TRUECONF_PASSWORD = '   '
    expect(readPassword()).toBeUndefined()
    expect(readPasswordRaw()).toBe('   ')
  })
  it('both readers return undefined when env var is unset', () => {
    expect(readPassword()).toBeUndefined()
    expect(readPasswordRaw()).toBeUndefined()
  })
})

describe('env-config readUseTls', () => {
  it('returns undefined when unset', () => {
    expect(readUseTls()).toBeUndefined()
  })
  it('returns true on literal "true"', () => {
    process.env.TRUECONF_USE_TLS = 'true'
    expect(readUseTls()).toBe(true)
  })
  it('returns false on literal "false"', () => {
    process.env.TRUECONF_USE_TLS = 'false'
    expect(readUseTls()).toBe(false)
  })
  it('returns undefined on any other value', () => {
    process.env.TRUECONF_USE_TLS = 'TRUE'
    expect(readUseTls()).toBeUndefined()
    process.env.TRUECONF_USE_TLS = '1'
    expect(readUseTls()).toBeUndefined()
    process.env.TRUECONF_USE_TLS = ''
    expect(readUseTls()).toBeUndefined()
  })
})

describe('env-config readPort', () => {
  it('returns undefined when unset', () => {
    expect(readPort()).toBeUndefined()
  })
  it('returns parsed integer when set', () => {
    process.env.TRUECONF_PORT = '4309'
    expect(readPort()).toBe(4309)
  })
  it('returns undefined on non-numeric (downstream falls back to default)', () => {
    process.env.TRUECONF_PORT = 'abc'
    expect(readPort()).toBeUndefined()
  })
  it('returns undefined when empty', () => {
    process.env.TRUECONF_PORT = ''
    expect(readPort()).toBeUndefined()
  })
})

describe('env-config readTlsVerify', () => {
  it('returns undefined when unset', () => {
    expect(readTlsVerify()).toBeUndefined()
  })
  it('returns trimmed "false" so caller can opt into insecure mode', () => {
    process.env.TRUECONF_TLS_VERIFY = '  false  '
    expect(readTlsVerify()).toBe('false')
  })
  it('returns the trimmed string for caller to validate (other values fall through)', () => {
    process.env.TRUECONF_TLS_VERIFY = 'maybe'
    expect(readTlsVerify()).toBe('maybe')
  })
})

describe('env-config readAcceptUntrustedCa / readAcceptRotatedCert', () => {
  it('return false when unset', () => {
    expect(readAcceptUntrustedCa()).toBe(false)
    expect(readAcceptRotatedCert()).toBe(false)
  })
  it('return true only on literal "true"', () => {
    process.env.TRUECONF_ACCEPT_UNTRUSTED_CA = 'true'
    process.env.TRUECONF_ACCEPT_ROTATED_CERT = 'true'
    expect(readAcceptUntrustedCa()).toBe(true)
    expect(readAcceptRotatedCert()).toBe(true)
  })
  it('return false on any other value (case-sensitive)', () => {
    process.env.TRUECONF_ACCEPT_UNTRUSTED_CA = 'TRUE'
    process.env.TRUECONF_ACCEPT_ROTATED_CERT = '1'
    expect(readAcceptUntrustedCa()).toBe(false)
    expect(readAcceptRotatedCert()).toBe(false)
  })
})

describe('env-config hasSetupShortcut', () => {
  it('returns true when SERVER_URL+USERNAME+PASSWORD are all set non-empty', () => {
    process.env.TRUECONF_SERVER_URL = 'tc.example.com'
    process.env.TRUECONF_USERNAME = 'bot'
    process.env.TRUECONF_PASSWORD = 'secret'
    expect(hasSetupShortcut()).toBe(true)
  })
  it('returns false when any one of the three is missing', () => {
    process.env.TRUECONF_SERVER_URL = 'tc.example.com'
    process.env.TRUECONF_USERNAME = 'bot'
    expect(hasSetupShortcut()).toBe(false)
  })
  it('returns false when any one is whitespace-only', () => {
    process.env.TRUECONF_SERVER_URL = 'tc.example.com'
    process.env.TRUECONF_USERNAME = 'bot'
    process.env.TRUECONF_PASSWORD = '   '
    expect(hasSetupShortcut()).toBe(false)
  })
})

describe('env-config readPositiveIntWithDefault (via readHeartbeatIntervalMs)', () => {
  it('returns default 30_000 when unset', () => {
    expect(readHeartbeatIntervalMs()).toBe(30_000)
  })
  it('returns parsed value on valid positive int', () => {
    process.env.TRUECONF_HEARTBEAT_INTERVAL_MS = '5000'
    expect(readHeartbeatIntervalMs()).toBe(5000)
  })
  it('trims surrounding whitespace before parsing', () => {
    process.env.TRUECONF_HEARTBEAT_INTERVAL_MS = '  5000  '
    expect(readHeartbeatIntervalMs()).toBe(5000)
  })
  it('falls back to default on non-numeric', () => {
    process.env.TRUECONF_HEARTBEAT_INTERVAL_MS = 'abc'
    expect(readHeartbeatIntervalMs()).toBe(30_000)
  })
  it('falls back to default on empty string', () => {
    process.env.TRUECONF_HEARTBEAT_INTERVAL_MS = ''
    expect(readHeartbeatIntervalMs()).toBe(30_000)
  })
  it('falls back to default on zero or negative', () => {
    process.env.TRUECONF_HEARTBEAT_INTERVAL_MS = '0'
    expect(readHeartbeatIntervalMs()).toBe(30_000)
    process.env.TRUECONF_HEARTBEAT_INTERVAL_MS = '-5'
    expect(readHeartbeatIntervalMs()).toBe(30_000)
  })
})

describe.each([
  ['TRUECONF_HEARTBEAT_PONG_TIMEOUT_MS', readHeartbeatPongTimeoutMs, 10_000, '5000', 5000],
  ['TRUECONF_OAUTH_TIMEOUT_MS', readOauthTimeoutMs, 15_000, '8000', 8000],
  ['TRUECONF_WS_HANDSHAKE_TIMEOUT_MS', readWsHandshakeTimeoutMs, 20_000, '12000', 12000],
  ['TRUECONF_OAUTH_FAIL_LIMIT', readOauthFailLimit, 3, '5', 5],
  ['TRUECONF_DNS_FAIL_LIMIT', readDnsFailLimit, 5, '8', 8],
])('env-config runtime tunable %s', (envName, reader, defaultValue, raw, parsed) => {
  it('returns the documented default when unset', () => {
    expect(reader()).toBe(defaultValue)
  })
  it('parses a valid positive integer', () => {
    process.env[envName] = raw
    expect(reader()).toBe(parsed)
  })
})

describe('env-config does not log secrets', () => {
  it('readPassword does not write to console', () => {
    process.env.TRUECONF_PASSWORD = 'super-secret-do-not-log'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const result = readPassword()
    expect(result).toBe('super-secret-do-not-log')

    expect(logSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()

    logSpy.mockRestore()
    errSpy.mockRestore()
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })
})
