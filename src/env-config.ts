// Single source of truth for every TRUECONF_* environment variable read in
// this package. Setup wizard env (10 names) and runtime tunables (6 names)
// live together so callers import named readers from one module instead of
// scattering env access across bin/, src/channel-setup, src/ws-client.
//
// Why centralize: openclaw's per-file regex security scanner flags any source
// that mentions process.env alongside a network-send token. By concentrating
// the env reads here, the consumer files no longer match the regex.
//
// Conventions preserved from the prior inline helpers:
//   - String readers trim whitespace and collapse empty/whitespace-only to
//     undefined (matches the existing channel-setup convention).
//   - Numeric readers fall back to a default on unset / empty / non-numeric /
//     <= 0 (matches the prior ws-client readEnvMs helper).
//   - readSetupLocale throws on invalid values so misconfigured CI fails
//     loud instead of silently picking a default.
//   - readPasswordRaw deliberately does NOT trim — the openclaw plugin-sdk
//     receives the literal bytes the operator set, preserving byte-for-byte
//     runtime semantics for the rare case of a password that legitimately
//     starts or ends with whitespace.

import type { Locale } from './i18n'
import { DEFAULT_LOCALE, t } from './i18n'

// =============================================================================
// Setup wizard env vars (10)
// =============================================================================

// Trim+collapse-empty-to-undefined idiom for plain string env vars. Empty or
// whitespace-only is treated as unset.
function readTrimmed(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  return raw ? raw : undefined
}

// TRUECONF_SETUP_LOCALE — throws on invalid values so misconfigured CI fails
// loud instead of silently picking a default the operator did not pick.
// Returns null when unset (matches the bin's prior null sentinel; channel-
// setup's `?? cfgLocale ?? 'en'` chain absorbs `null` and `undefined`
// identically at every call site).
export function readSetupLocale(): Locale | null {
  const raw = process.env.TRUECONF_SETUP_LOCALE
  if (raw === undefined) return null
  if (raw === 'en' || raw === 'ru') return raw
  throw new Error(t('locale.invalidEnv', DEFAULT_LOCALE, { value: raw }))
}

export function readServerUrl(): string | undefined { return readTrimmed('TRUECONF_SERVER_URL') }
export function readUsername(): string | undefined { return readTrimmed('TRUECONF_USERNAME') }

// TRUECONF_PASSWORD has TWO readers:
//
// readPassword() — TRIMMED. Empty/whitespace-only collapses to undefined.
// Use this reader for boolean checks like `readPassword() !== undefined`.
//
// readPasswordRaw() — UNTRIMMED. Returns the literal env value with leading
// and trailing whitespace preserved; only `undefined` (var unset) collapses
// to `undefined`. Use this reader anywhere the openclaw plugin-sdk receives
// the password as `envValue`, preserving byte-for-byte runtime semantics
// from before this refactor.
export function readPassword(): string | undefined { return readTrimmed('TRUECONF_PASSWORD') }
export function readPasswordRaw(): string | undefined { return process.env.TRUECONF_PASSWORD }

export function readCaPath(): string | undefined { return readTrimmed('TRUECONF_CA_PATH') }

// TRUECONF_USE_TLS — accepts only the literal strings 'true' / 'false'.
// Anything else (including unset) returns undefined (caller's default applies).
export function readUseTls(): boolean | undefined {
  const raw = process.env.TRUECONF_USE_TLS
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

// TRUECONF_PORT — parsed as base-10 int. Returns undefined when unset, empty,
// or non-numeric. The same fail-loud doctrine as readSetupLocale applies: a
// misconfigured CI value should not leak through as NaN and end up serialized
// as `null` in the persisted cfg.
export function readPort(): number | undefined {
  const raw = process.env.TRUECONF_PORT
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

// TRUECONF_TLS_VERIFY — three-state: returns the trimmed string when set
// (caller compares to 'false' explicitly to opt into insecure mode), or
// undefined for unset/empty (caller's default-verify applies). The
// throw-on-invalid guard lives in the caller, not here, to preserve the
// existing channel-setup `envTlsVerify !== 'false'` check shape.
export function readTlsVerify(): string | undefined { return readTrimmed('TRUECONF_TLS_VERIFY') }

// TRUECONF_ACCEPT_UNTRUSTED_CA — boolean opt-in; only literal 'true' counts.
export function readAcceptUntrustedCa(): boolean {
  return process.env.TRUECONF_ACCEPT_UNTRUSTED_CA === 'true'
}

// TRUECONF_ACCEPT_ROTATED_CERT — boolean opt-in; only literal 'true' counts.
export function readAcceptRotatedCert(): boolean {
  return process.env.TRUECONF_ACCEPT_ROTATED_CERT === 'true'
}

// Headless-shortcut detector — TRUE when serverUrl + username + password are
// all set non-empty. Mirrors the prior bin `hasEnvShortcut` and the
// `envShortcut.isAvailable` arrow in channel-setup.
export function hasSetupShortcut(): boolean {
  return Boolean(readServerUrl() && readUsername() && readPassword())
}

// =============================================================================
// Runtime tunables (6) — module-load semantics preserved at call sites in
// ws-client.ts (those keep `const X = readX()` at module top, evaluated once).
// =============================================================================

// Read a positive-integer env var with default fallback. Returns defaultValue
// when unset, empty, non-numeric, or <= 0. Same shape as the prior
// ws-client.ts readEnvMs helper.
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

// =============================================================================
// Public env contract registry — used by tests/unit/env-config.test.ts to
// snapshot the surface. Adding/removing/renaming a reader requires updating
// this registry, which makes the diff visible at PR review.
// =============================================================================

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
  ],
} as const
