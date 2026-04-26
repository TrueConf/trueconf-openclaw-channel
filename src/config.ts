import type {
  DmPolicy,
  TrueConfChannelConfig,
  TrueConfAccountConfig,
  ResolvedAccount,
  AccountDescription,
  Logger,
} from './types'
import { normalizeTitle } from './always-respond'

interface NormalizedConfig {
  accounts: Record<string, TrueConfAccountConfig & { enabled?: boolean }>
  dmPolicy: DmPolicy
  allowFrom?: string[]
}

function normalize(cfg: TrueConfChannelConfig): NormalizedConfig {
  if ('serverUrl' in cfg && !('accounts' in cfg)) {
    const { serverUrl, username, password, useTls, port, enabled, caPath, dmPolicy, allowFrom } = cfg
    return {
      accounts: { default: { serverUrl, username, password, useTls, port, enabled, caPath } },
      dmPolicy: dmPolicy ?? 'open',
      allowFrom,
    }
  }
  const multi = cfg as {
    accounts: Record<string, TrueConfAccountConfig & { enabled?: boolean }>
    dmPolicy?: DmPolicy
    allowFrom?: string[]
  }
  return {
    accounts: multi.accounts ?? {},
    dmPolicy: multi.dmPolicy ?? 'open',
    allowFrom: multi.allowFrom,
  }
}

function isRawConfigured(account: TrueConfAccountConfig): boolean {
  const resolvedPassword = resolveSecret(account.password)
  return (
    typeof account.serverUrl === 'string' && account.serverUrl.length > 0 &&
    typeof account.username === 'string' && account.username.length > 0 &&
    typeof resolvedPassword === 'string' && resolvedPassword.length > 0
  )
}

export function normalizePort(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number') return undefined
  if (!Number.isInteger(raw)) return undefined
  if (raw < 1 || raw > 65535) return undefined
  return raw
}

export function listAccountIds(cfg: TrueConfChannelConfig): string[] {
  return Object.keys(normalize(cfg).accounts)
}

export function resolveAccount(
  cfg: TrueConfChannelConfig,
  accountId?: string | null,
): ResolvedAccount {
  const normalized = normalize(cfg)
  const keys = Object.keys(normalized.accounts)
  const resolvedId = accountId == null ? keys[0] ?? 'default' : accountId
  const raw = normalized.accounts[resolvedId]
  if (!raw) {
    return { accountId: resolvedId, configured: false, enabled: false }
  }
  const configured = isRawConfigured(raw)
  const enabled = configured && raw.enabled !== false
  return {
    accountId: resolvedId,
    configured,
    enabled,
    serverUrl: raw.serverUrl,
    username: raw.username,
    password: resolveSecret(raw.password),
    useTls: raw.useTls,
    port: normalizePort(raw.port),
    caPath: raw.caPath,
  }
}

export function isConfigured(account: ResolvedAccount): boolean {
  return account.configured
}

export function isEnabled(account: ResolvedAccount): boolean {
  return account.enabled
}

export function describeAccount(account: ResolvedAccount): AccountDescription {
  return {
    accountId: account.accountId,
    name: account.accountId === 'default' ? 'TrueConf' : account.accountId,
    enabled: account.enabled,
    configured: account.configured,
  }
}

export function shouldAllowMessage(cfg: TrueConfChannelConfig, senderId: string): boolean {
  const normalized = normalize(cfg)
  switch (normalized.dmPolicy) {
    case 'open':
    case 'pairing':
      return true
    case 'allowlist':
      return normalized.allowFrom?.includes(senderId) ?? false
    case 'closed':
    case 'disabled':
      return false
    default:
      return true
  }
}

export type SecretRef = { useEnv: string }

export function resolveSecret(value: string | SecretRef | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'object' && 'useEnv' in value && typeof value.useEnv === 'string') {
    // `export TRUECONF_PASSWORD=$(cat file)` leaves a trailing newline that
    // silently fails OAuth. Trim and collapse whitespace-only env vars to
    // undefined so isRawConfigured's length>0 check flags them as not-set.
    const resolved = process.env[value.useEnv]
    return resolved === undefined ? undefined : resolved.trim() || undefined
  }
  return undefined
}

export interface ParsedAlwaysRespondConfig {
  readonly configuredChatIds: ReadonlySet<string>
  readonly configuredTitles: ReadonlySet<string>
}

export function parseAlwaysRespondConfig(
  raw: unknown,
  logger: Pick<Logger, 'warn'>,
): ParsedAlwaysRespondConfig {
  const configuredChatIds = new Set<string>()
  const configuredTitles = new Set<string>()
  if (raw === undefined || raw === null) return { configuredChatIds, configuredTitles }
  if (!Array.isArray(raw)) {
    logger.warn('[trueconf] always-respond: groupAlwaysRespondIn must be an array of strings; ignoring')
    return { configuredChatIds, configuredTitles }
  }

  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) {
      logger.warn(`[trueconf] always-respond: entry ${JSON.stringify(entry)} is not a non-empty NUL-free string, skipping`)
      continue
    }

    let kind: 'chatId' | 'title'
    let suffix: string
    if (entry.startsWith('chatId:')) {
      kind = 'chatId'
      suffix = entry.slice('chatId:'.length).trim()
    } else if (entry.startsWith('title:')) {
      kind = 'title'
      suffix = normalizeTitle(entry.slice('title:'.length))
    } else {
      kind = 'title'
      suffix = normalizeTitle(entry)
    }

    if (suffix.length === 0) {
      logger.warn(`[trueconf] always-respond: entry "${entry}" has empty suffix, skipping`)
      continue
    }

    const target = kind === 'chatId' ? configuredChatIds : configuredTitles
    if (target.has(suffix)) {
      logger.warn(`[trueconf] always-respond: duplicate ${kind} entry "${suffix}", deduplicating`)
      continue
    }
    target.add(suffix)
  }

  return { configuredChatIds, configuredTitles }
}
