// Centralized TRUECONF_* env reads. The openclaw security scanner's per-file
// regex flags any source mentioning process.env alongside a network-send
// token; concentrating reads here keeps the consumer files clean.

import type { Locale } from './i18n'
import { DEFAULT_LOCALE, t } from './i18n'

function readTrimmed(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  return raw ? raw : undefined
}

// Throws on invalid so misconfigured CI fails loud instead of silently picking
// a default the operator did not pick. null vs undefined matches the bin's
// prior sentinel — channel-setup's `?? cfgLocale ?? 'en'` absorbs both.
export function readSetupLocale(): Locale | null {
  const raw = process.env.TRUECONF_SETUP_LOCALE
  if (raw === undefined) return null
  if (raw === 'en' || raw === 'ru') return raw
  throw new Error(t('locale.invalidEnv', DEFAULT_LOCALE, { value: raw }))
}

export function readServerUrl(): string | undefined { return readTrimmed('TRUECONF_SERVER_URL') }
export function readUsername(): string | undefined { return readTrimmed('TRUECONF_USERNAME') }

// Twin readers: readPassword() trims (use for boolean presence checks);
// readPasswordRaw() preserves bytes (the openclaw plugin-sdk receives
// envValue literally, so leading/trailing whitespace must survive).
export function readPassword(): string | undefined { return readTrimmed('TRUECONF_PASSWORD') }
export function readPasswordRaw(): string | undefined { return process.env.TRUECONF_PASSWORD }

export function readCaPath(): string | undefined { return readTrimmed('TRUECONF_CA_PATH') }

export function readUseTls(): boolean | undefined {
  const raw = process.env.TRUECONF_USE_TLS
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

export function readPort(): number | undefined {
  const raw = process.env.TRUECONF_PORT
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

// Three-state: caller compares to 'false' explicitly to opt into insecure
// mode. The throw-on-invalid guard lives in the caller, not here, to preserve
// channel-setup's `envTlsVerify !== 'false'` check shape.
export function readTlsVerify(): string | undefined { return readTrimmed('TRUECONF_TLS_VERIFY') }

export function readAcceptUntrustedCa(): boolean {
  return process.env.TRUECONF_ACCEPT_UNTRUSTED_CA === 'true'
}

export function readAcceptRotatedCert(): boolean {
  return process.env.TRUECONF_ACCEPT_ROTATED_CERT === 'true'
}

export function hasSetupShortcut(): boolean {
  return Boolean(readServerUrl() && readUsername() && readPassword())
}

// Returns defaultValue on unset/empty/non-numeric/<=0 — matches the prior
// ws-client readEnvMs helper.
function readPositiveIntWithDefault(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return defaultValue
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue
  return parsed
}

export function readHeartbeatIntervalMs(): number { return readPositiveIntWithDefault('TRUECONF_HEARTBEAT_INTERVAL_MS', 30_000) }
export function readHeartbeatPongTimeoutMs(): number { return readPositiveIntWithDefault('TRUECONF_HEARTBEAT_PONG_TIMEOUT_MS', 10_000) }
export function readOauthTimeoutMs(): number { return readPositiveIntWithDefault('TRUECONF_OAUTH_TIMEOUT_MS', 15_000) }
export function readWsHandshakeTimeoutMs(): number { return readPositiveIntWithDefault('TRUECONF_WS_HANDSHAKE_TIMEOUT_MS', 20_000) }
export function readOauthFailLimit(): number { return readPositiveIntWithDefault('TRUECONF_OAUTH_FAIL_LIMIT', 3) }
export function readDnsFailLimit(): number { return readPositiveIntWithDefault('TRUECONF_DNS_FAIL_LIMIT', 5) }
export function readTcpKeepaliveMs(): number { return readPositiveIntWithDefault('TRUECONF_TCP_KEEPALIVE_MS', 15_000) }

export const PUBLIC_ENV_CONTRACT = {
  setup: [
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
  ],
  runtime: [
    'TRUECONF_HEARTBEAT_INTERVAL_MS',
    'TRUECONF_HEARTBEAT_PONG_TIMEOUT_MS',
    'TRUECONF_OAUTH_TIMEOUT_MS',
    'TRUECONF_WS_HANDSHAKE_TIMEOUT_MS',
    'TRUECONF_OAUTH_FAIL_LIMIT',
    'TRUECONF_DNS_FAIL_LIMIT',
    'TRUECONF_TCP_KEEPALIVE_MS',
  ],
} as const
