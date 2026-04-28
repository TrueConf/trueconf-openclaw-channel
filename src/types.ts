import type { OpenClawConfig } from 'openclaw/plugin-sdk/setup'
import type { Locale } from './i18n'

export type SetupLocale = Locale

export interface TrueConfAccountConfig {
  serverUrl: string
  username: string
  password: string | { useEnv: string }
  useTls: boolean
  port?: number
  clientId?: string
  clientSecret?: string
  enabled?: boolean
  caPath?: string
  tlsVerify?: boolean
  setupLocale?: SetupLocale
}

// Pick over free-standing interface so renames in TrueConfAccountConfig
// break this type at compile time instead of drifting silently.
export type TrueConfChannelSection = Partial<Pick<TrueConfAccountConfig,
  | 'serverUrl'
  | 'username'
  | 'password'
  | 'useTls'
  | 'port'
  | 'caPath'
  | 'tlsVerify'
  | 'setupLocale'
>>

export function readTrueConfSection(cfg: OpenClawConfig): TrueConfChannelSection {
  const raw = (cfg as { channels?: { trueconf?: unknown } }).channels?.trueconf
  if (raw === null || typeof raw !== 'object') return {}
  return raw as TrueConfChannelSection
}

export interface TrueConfRequest {
  type: 1
  id: number
  method: string
  payload?: Record<string, unknown>
}

export interface TrueConfResponse {
  type: 2
  id: number
  payload?: Record<string, unknown>
}

export const EnvelopeType = {
  ADD_PARTICIPANT: 1,
  REMOVE_PARTICIPANT: 2,
  PARTICIPANT_ROLE: 110,
  PLAIN_MESSAGE: 200,
  FORWARDED_MESSAGE: 201,
  ATTACHMENT: 202,
  SURVEY: 204,
} as const
export type EnvelopeType = (typeof EnvelopeType)[keyof typeof EnvelopeType]

export const TrueConfChatType = {
  UNDEF: 0,
  P2P: 1,
  GROUP: 2,
  SYSTEM: 3,
  FAVORITES: 5,
  CHANNEL: 6,
} as const
export type TrueConfChatType = (typeof TrueConfChatType)[keyof typeof TrueConfChatType]

export type ResolvedChatKind = 'p2p' | 'group' | 'channel' | 'unknown'

export const FileReadyState = { NOT_AVAILABLE: 0, UPLOADING: 1, READY: 2 } as const
export type FileReadyState = (typeof FileReadyState)[keyof typeof FileReadyState]

export const ErrorCode = {
  DUPLICATE_ID: 2,
  NOT_AUTHORIZED: 200,
  INVALID_CREDENTIALS: 201,
  CREDENTIALS_EXPIRED: 203,
  INTERNAL_ERROR: 300,
  CHAT_NOT_FOUND: 304,
  MESSAGE_NOT_FOUND: 306,
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

interface BaseEnvelope {
  messageId: string
  chatId: string
  timestamp: number
  replyMessageId?: string
  isEdited: boolean
  author: { id: string; type: 0 | 1 }
  box: { id: number; position: string }
}

export interface TextEnvelope extends BaseEnvelope {
  type: typeof EnvelopeType.PLAIN_MESSAGE
  content: { text: string; parseMode: 'text' | 'markdown' | 'html' }
}

export interface AttachmentEnvelope extends BaseEnvelope {
  type: typeof EnvelopeType.ATTACHMENT
  content: AttachmentContent
}

export interface SystemEnvelope extends BaseEnvelope {
  type: Exclude<EnvelopeType, typeof EnvelopeType.PLAIN_MESSAGE | typeof EnvelopeType.ATTACHMENT>
  content?: unknown
}

export type Envelope = TextEnvelope | AttachmentEnvelope | SystemEnvelope

export interface AttachmentContent {
  name: string
  mimeType: string
  size: number
  fileId: string
  readyState: FileReadyState
}

export interface FileInfo {
  name: string
  size: number
  mimeType: string
  downloadUrl: string | null
  readyState: FileReadyState
  infoHash: string
  previews: Array<{ name: string; mimeType: string; size: number; downloadUrl: string }> | null
}

export interface OAuthTokenResponse {
  access_token: string
  token_type: string
  expires_at: number
}

export interface InboundMessage {
  channel: string
  accountId: string
  peerId: string
  chatId: string
  text: string
  messageId: string
  timestamp: number
  isGroup: boolean
  senderName: string
  senderId: string
  attachmentContent?: AttachmentContent
  replyMessageId?: string
  parseMode?: 'text' | 'markdown' | 'html'
}

export type InboundDispatchFn = (msg: InboundMessage) => void | Promise<void>

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const DmPolicy = {
  OPEN: 'open',
  PAIRING: 'pairing',
  ALLOWLIST: 'allowlist',
  CLOSED: 'closed',
  DISABLED: 'disabled',
} as const
export type DmPolicy = (typeof DmPolicy)[keyof typeof DmPolicy]

export interface TrueConfFlatConfig extends TrueConfAccountConfig {
  enabled?: boolean
  dmPolicy?: DmPolicy
  allowFrom?: string[]
  maxFileSize?: number
  groupAlwaysRespondIn?: string[]
}

export interface TrueConfMultiAccountConfig {
  accounts: Record<string, TrueConfAccountConfig & { enabled?: boolean }>
  dmPolicy?: DmPolicy
  allowFrom?: string[]
  maxFileSize?: number
  groupAlwaysRespondIn?: string[]
}

export type TrueConfChannelConfig = TrueConfFlatConfig | TrueConfMultiAccountConfig

export interface ResolvedAccount {
  accountId: string
  configured: boolean
  enabled: boolean
  serverUrl?: string
  username?: string
  password?: string
  useTls?: boolean
  port?: number
  caPath?: string
  tlsVerify?: boolean
  setupLocale?: SetupLocale
}

export interface AccountDescription {
  accountId: string
  name: string
  enabled: boolean
  configured: boolean
}

export function buildAuthRequest(id: number, token: string, receiveUnread = false): TrueConfRequest {
  return { type: 1, id, method: 'auth', payload: { token, tokenType: 'JWT', receiveUnread } }
}

export function buildAck(serverRequestId: number): TrueConfResponse {
  return { type: 2, id: serverRequestId }
}

export class IdCounter {
  private counter = 0
  next(): number { return ++this.counter }
  reset(): void { this.counter = 0 }
  current(): number { return this.counter }
}

interface PendingRequest {
  resolve: (response: TrueConfResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RequestMatcher {
  private pending = new Map<number, PendingRequest>()
  constructor(private timeoutMs = 30_000) {}

  track(id: number): Promise<TrueConfResponse> {
    return new Promise<TrueConfResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request ${id} timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  resolve(id: number, response: TrueConfResponse): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.resolve(response)
    return true
  }

  reject(id: number, error: Error): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.reject(error)
    return true
  }

  rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  get size(): number { return this.pending.size }
}
