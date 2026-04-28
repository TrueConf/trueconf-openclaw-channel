import { createWriteStream } from 'node:fs'
import { unlink, mkdir } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { basename, resolve as pathResolve, sep as pathSep, join as pathJoin } from 'node:path'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { getMediaDir, kindFromMime, type MediaKind } from 'openclaw/plugin-sdk/media-runtime'
import { fetch, type Response } from 'undici'
import { EnvelopeType, FileReadyState, TrueConfChatType } from './types'
import type {
  TrueConfRequest,
  Envelope,
  InboundDispatchFn,
  Logger,
  TrueConfChannelConfig,
  InboundMessage,
  FileInfo,
  ResolvedChatKind,
  AttachmentContent,
} from './types'
import { WsClient, hostPort } from './ws-client'
import { sendText, sendTextToChat, isReconnectableSendError } from './outbound'
import { resolveAccount } from './config'
import { PerChatSendQueue } from './send-queue'

const DEFAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024
const COALESCE_WINDOW_MS = 300
const RECENT_BOT_MSG_PER_CHAT_CAP = 50
const bytesToMB = (n: number): number => (n > 0 ? Math.ceil(n / (1024 * 1024)) : 0)

// TrueConf renders @-mentions as <a href="trueconf:user@server...">Name</a>
// inside parseMode='html' content. The href may be followed by a slash+instance
// suffix (/abc123) or query params (&do=profile, ?k=v). We stop the userId
// capture at any of /, &, ? — whichever separator appears first.
const MENTION_RE = /<a\s+[^>]*href="trueconf:([^"/&?]+)[^"]*"/gi

export function extractMentionedUserIds(text: string, parseMode: string | undefined): string[] {
  if (parseMode !== 'html') return []
  const ids: string[] = []
  for (const match of text.matchAll(MENTION_RE)) {
    if (match[1]) ids.push(match[1])
  }
  return ids
}

export function isReplyToBot(
  replyMessageId: string | undefined,
  recent: Set<string> | undefined,
): boolean {
  return !!replyMessageId && !!recent?.has(replyMessageId)
}

// TrueConf html mode supports only <b>, <i>, <s>, <u>, <a>; tag stripping is
// enough to pass clean text to the LLM.
export function stripHtmlTags(text: string): string {
  return text.replace(/<\/?[^>]+(>|$)/g, '').trim()
}

export function rememberBotMessage(
  map: Map<string, Set<string>>,
  chatId: string,
  messageId: string,
): void {
  let set = map.get(chatId)
  if (!set) {
    set = new Set()
    map.set(chatId, set)
  }
  set.add(messageId)
  if (set.size > RECENT_BOT_MSG_PER_CHAT_CAP) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
}

// On any failure path (errorCode, unrecognized chatType, exception) we return
// 'unknown' WITHOUT caching, so the next message in this chat retries the
// lookup. Caller MUST drop unknown — downgrading to 'p2p' would skip the
// group mention/reply gate during transient failures and cause unsolicited
// replies in groups/channels.
export async function resolveChatType(params: {
  wsClient: WsClient
  chatId: string
  cache: Map<string, ResolvedChatKind>
  inflight: Map<string, Promise<ResolvedChatKind>>
  logger: Logger
}): Promise<ResolvedChatKind> {
  const cached = params.cache.get(params.chatId)
  if (cached) return cached
  const existing = params.inflight.get(params.chatId)
  if (existing) return existing

  const lookup = (async (): Promise<ResolvedChatKind> => {
    try {
      const resp = await params.wsClient.sendRequest('getChatByID', { chatId: params.chatId })
      const errorCode = resp.payload?.errorCode
      if (typeof errorCode === 'number' && errorCode !== 0) {
        params.logger.warn(
          `[trueconf] getChatByID errorCode ${errorCode} for chatId=${params.chatId}; treating as unknown (will retry on next message)`,
        )
        return 'unknown'
      }
      const chatType = resp.payload?.chatType
      if (chatType === TrueConfChatType.GROUP) { params.cache.set(params.chatId, 'group'); return 'group' }
      if (chatType === TrueConfChatType.CHANNEL) { params.cache.set(params.chatId, 'channel'); return 'channel' }
      if (chatType === TrueConfChatType.P2P) { params.cache.set(params.chatId, 'p2p'); return 'p2p' }
      params.logger.warn(
        `[trueconf] getChatByID returned unrecognized chatType ${JSON.stringify(chatType)} for chatId=${params.chatId}; treating as unknown`,
      )
      return 'unknown'
    } catch (err) {
      params.logger.warn(
        `[trueconf] getChatByID failed for chatId=${params.chatId}: ${err instanceof Error ? err.message : String(err)}; treating as unknown (will retry on next message)`,
      )
      return 'unknown'
    }
  })()

  params.inflight.set(params.chatId, lookup)
  try {
    return await lookup
  } finally {
    params.inflight.delete(params.chatId)
  }
}

// TrueConf delivers text-with-file as two separate envelopes (type 200 then 202)
// with no correlationId. We buffer a lone text envelope for COALESCE_WINDOW_MS so
// that a following attachment from the same (account, chat, peer) can be merged
// into a single dispatch with the real caption preserved. If no attachment
// arrives within the window, the timer flushes the text alone.
interface PendingTextInbound {
  base: Omit<InboundMessage, 'text' | 'attachmentContent'>
  text: string
  timer: ReturnType<typeof setTimeout>
  dispatch: InboundDispatchFn
  logger: Logger
}
const pendingTextInbounds = new Map<string, PendingTextInbound>()

function coalesceKey(accountId: string, chatId: string, peerId: string): string {
  return `${accountId}\u0000${chatId}\u0000${peerId}`
}

function flushPendingText(key: string): void {
  const pending = pendingTextInbounds.get(key)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingTextInbounds.delete(key)
  dispatchWithFence(pending.dispatch, { ...pending.base, text: pending.text }, pending.logger)
}

export function __resetCoalesceBufferForTesting(): void {
  for (const pending of pendingTextInbounds.values()) {
    clearTimeout(pending.timer)
  }
  pendingTextInbounds.clear()
}

const ERR_NOT_AVAILABLE = 'Файл недоступен на сервере — возможно, он был удалён. Отправьте ещё раз.'
const ERR_GENERIC = 'Не удалось обработать файл — попробуйте ещё раз.'

export function normalizeForCompare(value: string | null | undefined): string {
  return (value ?? '').replace(/\/.*$/, '').trim().toLowerCase()
}

function normalizeForRouting(value: string | null | undefined): string {
  return (value ?? '').replace(/\/.*$/, '').trim()
}

function requireNonEmpty(kind: string, value: string): string {
  if (!value) throw new Error(`${kind}: must not be empty`)
  if (value.includes('\u0000')) throw new Error(`${kind}: must not contain NUL byte`)
  return value
}

export interface InboundContext {
  wsClient: WsClient
  botIdentityCandidates: string[]
  accountId: string
  dispatch: InboundDispatchFn
  logger: Logger
  directChats: Map<string, string>
  chatTypes: Map<string, ResolvedChatKind>
  inflightChatTypes: Map<string, Promise<ResolvedChatKind>>
  recentBotMsgIds: Map<string, Set<string>>
  isAlwaysRespond: (chatId: string) => boolean
}

export async function handleInboundMessage(
  msg: TrueConfRequest,
  ctx: InboundContext,
): Promise<void> {
  // Auto-ack happens in WsClient.connect's ws.on('message') handler — see
  // ws-client.ts. handleInboundMessage only routes sendMessage envelopes.
  if (msg.method !== 'sendMessage') return

  const envelope = msg.payload as unknown as Envelope | undefined
  if (!envelope || !envelope.author || !envelope.content) return

  let rawAuthorId: string
  let stableUserId: string
  let chatId: string
  try {
    rawAuthorId = requireNonEmpty('RawAuthorId', envelope.author.id)
    stableUserId = requireNonEmpty('StableUserId', normalizeForRouting(rawAuthorId))
    chatId = requireNonEmpty('ChatId', envelope.chatId.trim())
  } catch (err) {
    ctx.logger.warn(
      `[trueconf] Dropping inbound message with invalid routing ids: ${err instanceof Error ? err.message : String(err)} author.id=${JSON.stringify(envelope.author.id)} chatId=${JSON.stringify(envelope.chatId)}`,
    )
    return
  }

  const normalizedAuthor = normalizeForCompare(rawAuthorId)
  if (normalizedAuthor && ctx.botIdentityCandidates.some((c) => normalizeForCompare(c) === normalizedAuthor)) return
  if (envelope.type < 200) return

  const kind = await resolveChatType({
    wsClient: ctx.wsClient,
    chatId,
    cache: ctx.chatTypes,
    inflight: ctx.inflightChatTypes,
    logger: ctx.logger,
  })

  if (kind === 'channel') {
    ctx.logger.info(`[trueconf] dropping channel message chatId=${chatId}`)
    return
  }

  // Fail-closed: never downgrade unknown to direct, that path skips the gate.
  if (kind === 'unknown') {
    ctx.logger.warn(`[trueconf] dropping inbound from chatId=${chatId}: chat type unknown`)
    return
  }

  const key = coalesceKey(ctx.accountId, chatId, stableUserId)

  // Pre-validate envelope shape and build synthetic text + extraContext for
  // non-PLAIN types. Validation runs BEFORE the group gate so malformed
  // envelopes are dropped via logger.warn regardless of chat kind.
  let plainText: string | null = null
  let plainParseMode: 'text' | 'markdown' | 'html' | undefined
  let syntheticText: string | null = null
  let extraContext: Record<string, unknown> | undefined
  let attachment: AttachmentContent | null = null

  if (envelope.type === EnvelopeType.PLAIN_MESSAGE) {
    const content = envelope.content as { text: string; parseMode?: string }
    const parseMode = content.parseMode as 'text' | 'markdown' | 'html' | undefined
    plainText = parseMode === 'html' ? stripHtmlTags(content.text) : content.text
    plainParseMode = parseMode
  } else if (envelope.type === EnvelopeType.FORWARDED_MESSAGE) {
    const c = envelope.content as { text?: unknown; parseMode?: unknown } | undefined
    if (!c || typeof c.text !== 'string') {
      ctx.logger.warn('[trueconf] FORWARDED_MESSAGE без text; dropping')
      return
    }
    const parseMode = typeof c.parseMode === 'string'
      ? (c.parseMode as 'text' | 'markdown' | 'html')
      : undefined
    syntheticText = parseMode === 'html' ? stripHtmlTags(c.text) : c.text
    plainParseMode = parseMode
    extraContext = { TrueConfEnvelopeType: 'forwarded' }
  } else if (envelope.type === EnvelopeType.ATTACHMENT) {
    const a = envelope.content as AttachmentContent | undefined
    if (!a || typeof a.fileId !== 'string' || typeof a.name !== 'string') {
      ctx.logger.warn('[trueconf] ATTACHMENT envelope missing required fields')
      return
    }
    attachment = a
  } else if (envelope.type === EnvelopeType.LOCATION) {
    const loc = envelope.content as
      | { latitude?: unknown; longitude?: unknown; description?: unknown }
      | undefined
    if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') {
      ctx.logger.warn('[trueconf] LOCATION без lat/lng; dropping')
      return
    }
    const description = typeof loc.description === 'string' && loc.description.length > 0
      ? loc.description
      : null
    syntheticText = description !== null
      ? `[Локация: lat=${loc.latitude}, lng=${loc.longitude}, описание: ${description}]`
      : `[Локация: lat=${loc.latitude}, lng=${loc.longitude}]`
    extraContext = {
      TrueConfEnvelopeType: 'location',
      location: { latitude: loc.latitude, longitude: loc.longitude, description },
    }
  } else if (envelope.type === EnvelopeType.SURVEY) {
    const survey = envelope.content as { title?: unknown } | undefined
    if (!survey || typeof survey.title !== 'string') {
      ctx.logger.warn('[trueconf] SURVEY без title; dropping')
      return
    }
    syntheticText = `[Опрос: «${survey.title}»]`
    extraContext = { TrueConfEnvelopeType: 'survey', survey: envelope.content }
  } else {
    ctx.logger.info(`[trueconf] unsupported envelope type ${envelope.type}; dropping`)
    return
  }

  // Group activation gate (skipped when isAlwaysRespond(chatId) is true):
  // bot must be @-mentioned (html) or the message must reply to a recent bot
  // message. ATTACHMENT/LOCATION/SURVEY envelopes still pass when a preceding
  // gated text is waiting in the coalescer (caption + media as one turn).
  if (kind === 'group' && !ctx.isAlwaysRespond(chatId)) {
    let activated = false
    if (envelope.type === EnvelopeType.PLAIN_MESSAGE) {
      const content = envelope.content as { text: string; parseMode?: string }
      const botUserId = ctx.wsClient.botUserId ?? ''
      const normalizedBot = normalizeForCompare(botUserId)
      const mentioned = normalizedBot.length > 0 && extractMentionedUserIds(content.text, content.parseMode).some(
        (id) => normalizeForCompare(id) === normalizedBot,
      )
      const replied = isReplyToBot(envelope.replyMessageId, ctx.recentBotMsgIds.get(chatId))
      activated = mentioned || replied
    } else if (envelope.type === EnvelopeType.FORWARDED_MESSAGE) {
      // Forwards don't carry the bot's mention markup, so reply-to-bot is the
      // only direct activation path. A preceding gated text in the coalescer
      // also activates (forward as a follow-up to a captioned turn).
      const replied = isReplyToBot(envelope.replyMessageId, ctx.recentBotMsgIds.get(chatId))
      activated = replied || pendingTextInbounds.has(key)
    } else if (
      envelope.type === EnvelopeType.ATTACHMENT
      || envelope.type === EnvelopeType.LOCATION
      || envelope.type === EnvelopeType.SURVEY
    ) {
      const replied = isReplyToBot(envelope.replyMessageId, ctx.recentBotMsgIds.get(chatId))
      activated = replied || pendingTextInbounds.has(key)
    }
    if (!activated) {
      ctx.logger.info(`[trueconf] group ${chatId}: no mention/reply for type ${envelope.type}, dropping`)
      return
    }
  }

  // Only register a direct-chat mapping for true P2P chats; for groups the
  // chatId is shared and reusing it as a per-user key would misroute outbound.
  if (kind === 'p2p') {
    ctx.directChats.set(`${ctx.accountId}\u0000${stableUserId}`, chatId)
  }

  // Group routing: peerId = chatId so the LLM sees one conversation per group
  // (senderId is preserved on the dispatched message for attribution).
  const peerId = kind === 'group' ? chatId : stableUserId

  const base: Omit<InboundMessage, 'text' | 'attachmentContent'> = {
    channel: 'trueconf',
    accountId: ctx.accountId,
    peerId,
    chatId,
    senderId: stableUserId,
    messageId: envelope.messageId,
    timestamp: envelope.timestamp,
    isGroup: kind === 'group',
    senderName: stableUserId,
    replyMessageId: envelope.replyMessageId,
    ...(plainParseMode ? { parseMode: plainParseMode } : {}),
    ...(extraContext ? { extraContext } : {}),
  }

  if (envelope.type === EnvelopeType.PLAIN_MESSAGE) {
    if (pendingTextInbounds.has(key)) flushPendingText(key)
    const timer = setTimeout(() => flushPendingText(key), COALESCE_WINDOW_MS)
    timer.unref?.()
    pendingTextInbounds.set(key, { base, text: plainText!, timer, dispatch: ctx.dispatch, logger: ctx.logger })
    return
  }

  if (envelope.type === EnvelopeType.ATTACHMENT) {
    const pending = pendingTextInbounds.get(key)
    let text: string
    if (pending) {
      clearTimeout(pending.timer)
      pendingTextInbounds.delete(key)
      text = pending.text
    } else {
      text = `[File: ${sanitizeAttachmentName(attachment!.name)}]`
    }
    dispatchWithFence(ctx.dispatch, { ...base, text, attachmentContent: attachment! }, ctx.logger)
    return
  }

  // FORWARDED, LOCATION, SURVEY all go through the same coalescer-buffered
  // path as PLAIN. A trailing attachment in the coalesce window will replace
  // the synthetic placeholder with the real caption from this envelope.
  if (pendingTextInbounds.has(key)) flushPendingText(key)
  const timer = setTimeout(() => flushPendingText(key), COALESCE_WINDOW_MS)
  timer.unref?.()
  pendingTextInbounds.set(key, { base, text: syntheticText!, timer, dispatch: ctx.dispatch, logger: ctx.logger })
}

function dispatchWithFence(dispatch: InboundDispatchFn, inbound: InboundMessage, logger: Logger): void {
  const ctx = `peer=${inbound.peerId} chatId=${inbound.chatId} messageId=${inbound.messageId}`
  try {
    Promise.resolve(dispatch(inbound)).catch((err: unknown) => {
      logger.error(`[trueconf] Dispatch failed (${ctx}): ${err instanceof Error ? err.message : String(err)}`)
    })
  } catch (err) {
    logger.error(`[trueconf] Dispatch failed (${ctx}): ${err instanceof Error ? err.message : String(err)}`)
  }
}

function sanitizeAttachmentName(rawName: string): string {
  const lastSegment = rawName.split(/[/\\]/).pop() ?? ''
  const cleaned = lastSegment.replace(/\p{Cc}/gu, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'unnamed'
  return cleaned
}

export function resolveAttachmentDir(logger?: Logger): string {
  try {
    const mediaDir = getMediaDir()
    if (mediaDir) return pathJoin(mediaDir, 'trueconf-inbound')
  } catch (err) {
    logger?.warn(
      `[trueconf] getMediaDir threw: ${err instanceof Error ? err.message : String(err)} — using tmpdir`,
    )
  }
  return tmpdir()
}

async function ensureAttachmentDirExists(logger: Logger): Promise<void> {
  const dir = resolveAttachmentDir(logger)
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    logger.warn(
      `[trueconf] ensureAttachmentDirExists: mkdir(${dir}) failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function buildSanitizedTempPath(originalName: string): {
  tempPath: string
  sanitizedOriginalName: string
} {
  let safe = basename(originalName).replace(/\p{Cc}/gu, '')
  if (!safe || safe === '.' || safe === '..') safe = 'unnamed'
  const attachmentDir = resolveAttachmentDir()
  const candidate = `${attachmentDir}${pathSep}trueconf-${crypto.randomUUID()}-${safe}`
  const resolvedCandidate = pathResolve(candidate)
  const resolvedDir = pathResolve(attachmentDir)
  if (!resolvedCandidate.startsWith(resolvedDir + pathSep) && resolvedCandidate !== resolvedDir) {
    throw new Error(`Path traversal detected: ${candidate} escapes ${resolvedDir}`)
  }
  return { tempPath: resolvedCandidate, sanitizedOriginalName: safe }
}

export async function downloadFile(
  downloadUrl: string,
  destPath: string,
  maxBytes: number,
  logger: Logger,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(downloadUrl)
  } catch {
    return { ok: false, error: 'invalid_url_scheme' }
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return { ok: false, error: 'invalid_url_scheme' }
  }

  let response: Response
  try {
    logger.info(`[trueconf] downloadFile: fetching ${downloadUrl}`)
    response = await fetch(downloadUrl)
  } catch (err) {
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined
    const causeMsg = cause instanceof Error ? cause.message : cause != null ? String(cause) : ''
    return {
      ok: false,
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}${causeMsg ? ' | cause: ' + causeMsg : ''}`,
    }
  }

  if (!response.ok) return { ok: false, error: `HTTP ${response.status} ${response.statusText}` }
  if (!response.body) return { ok: false, error: 'Response body is null' }

  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, error: `content-length ${contentLength} exceeds max ${maxBytes}` }
    }
  }

  // Streaming cap covers servers that omit content-length.
  let bytesWritten = 0
  const boundedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length
      if (bytesWritten > maxBytes) {
        callback(new Error(`streamed bytes ${bytesWritten} exceeds max ${maxBytes}`))
        return
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
      boundedCounter,
      createWriteStream(destPath),
    )
    return { ok: true }
  } catch (err) {
    try { await unlink(destPath) } catch (unlinkErr) {
      logger.warn(
        `[trueconf] Failed to unlink partial download ${destPath}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
      )
    }
    return { ok: false, error: `stream pipeline failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function getMaxFileSize(cfg: TrueConfChannelConfig): number {
  const raw = (cfg as unknown as { maxFileSize?: unknown }).maxFileSize
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  return DEFAULT_MAX_FILE_SIZE_BYTES
}

// Wait for the server to finish receiving the file bytes. Subscribes via
// subscribeFileProgress and listens for uploadFileProgress events (note: docs
// call this method `uploadingProgress`, but TrueConf Server actually sends
// `uploadFileProgress` — verified on bots.trueconf.com). For federated
// senders the progress event fires once the inter-server BitTorrent transfer
// completes.
async function waitUploadComplete(
  wsClient: WsClient,
  fileId: string,
  expectedSize: number,
  timeoutMs: number,
  logger: Logger,
): Promise<{ ok: true } | { ok: false; reason: 'timeout' | 'subscribe_failed' | 'reconnect' }> {
  type Result = { ok: true } | { ok: false; reason: 'timeout' | 'subscribe_failed' | 'reconnect' }
  let resolve!: (v: Result) => void
  const promise = new Promise<Result>((r) => { resolve = r })
  let settled = false
  const settle = (v: Result): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    wsClient.offFileProgress(fileId)
    resolve(v)
  }
  // Register handler + timer BEFORE subscribing: the server sometimes pushes
  // the uploadFileProgress event ahead of the subscribe response.
  const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), timeoutMs)
  wsClient.onFileProgress(fileId, (progress) => {
    logger.info(`[trueconf] uploadFileProgress fileId=${fileId} progress=${progress} expected=${expectedSize}`)
    if (progress >= expectedSize) settle({ ok: true })
  })

  try {
    const subResp = await wsClient.sendRequest('subscribeFileProgress', { fileId })
    const errorCode = typeof subResp.payload?.errorCode === 'number' ? subResp.payload.errorCode : undefined
    if (errorCode !== undefined && errorCode !== 0) {
      logger.warn(`[trueconf] subscribeFileProgress errorCode ${errorCode} (fileId=${fileId})`)
      settle({ ok: false, reason: 'subscribe_failed' })
    }
  } catch (err) {
    logger.warn(`[trueconf] subscribeFileProgress failed (fileId=${fileId}): ${err instanceof Error ? err.message : String(err)}`)
    settle({ ok: false, reason: isReconnectableSendError(err) ? 'reconnect' : 'subscribe_failed' })
  }

  const result = await promise
  if (result.ok) {
    // Best-effort: keep the server-side subscription table tidy. If this
    // fails the server drops the subscription on its own when the socket
    // closes or during idle sweeps.
    wsClient.sendRequest('unsubscribeFileProgress', { fileId }).catch(() => {})
  }
  return result
}

// Poll getFileInfo briefly after uploadFileProgress signalled completion.
// The server can lag the readyState flip by a few hundred ms, so we retry
// for a short window to get a fresh downloadUrl with READY state.
async function pollForReady(
  wsClient: WsClient,
  fileId: string,
  timeoutMs: number,
  logger: Logger,
): Promise<FileInfo | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let resp: Awaited<ReturnType<WsClient['sendRequest']>>
    try {
      resp = await wsClient.sendRequest('getFileInfo', { fileId })
    } catch (err) {
      logger.warn(`[trueconf] pollForReady: getFileInfo failed (fileId=${fileId}): ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    const info = resp.payload as unknown as FileInfo
    if (info.readyState === FileReadyState.READY && info.downloadUrl != null) return info
    if (info.readyState === FileReadyState.NOT_AVAILABLE) return null
    await new Promise((r) => setTimeout(r, 500))
  }
  logger.warn(`[trueconf] pollForReady: timed out waiting for READY (fileId=${fileId})`)
  return null
}

export interface InboundAttachmentReady {
  ok: true
  tempPath: string
  sanitizedName: string
  mimeType: string
  kindLabel: string
  size: number
}

// Download the inbound attachment and prepare extraContext for dispatch. Error
// replies are sent here; on failure returns { ok: false } and the caller
// skips dispatch. On success the caller must dispatch AND is responsible for
// unlinking `tempPath` if dispatch itself throws.
export async function prepareInboundAttachment(params: {
  inboundMsg: InboundMessage
  wsClient: WsClient
  accountId: string
  store: { directChatsByStableUserId: Map<string, string> }
  channelConfig: TrueConfChannelConfig
  logger: Logger
  // Per-account send queue threaded by channel.ts. Error-reply paths in this
  // function call sendText/sendTextToChat, which require a queue to serialize
  // chunks per chatId. Owning the queue at the account level keeps replies
  // from one account from blocking on another's outbound burst.
  sendQueue: PerChatSendQueue
}): Promise<InboundAttachmentReady | { ok: false }> {
  const { inboundMsg, wsClient, accountId, store, channelConfig, logger, sendQueue } = params
  const attachment = inboundMsg.attachmentContent
  if (!attachment) {
    logger.error('[trueconf] prepareInboundAttachment called without attachmentContent')
    return { ok: false }
  }

  // For groups inboundMsg.peerId === chatId; sendText would (mis)treat it as
  // a userId and try to createP2PChat. Route group error replies straight to
  // the chatId so the user actually sees the failure feedback.
  const replyOn = async (text: string) => {
    try {
      const result = inboundMsg.isGroup
        ? await sendTextToChat(wsClient, inboundMsg.chatId, text, logger, sendQueue)
        : await sendText(wsClient, inboundMsg.peerId, text, logger, {
            fallbackUserId: inboundMsg.peerId,
            directChatStore: store,
            accountId,
            sendQueue,
          })
      if (!result.ok) logger.warn('[trueconf] replyErrorText: send returned ok=false')
    } catch (err) {
      logger.error(`[trueconf] replyErrorText: send threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const maxBytes = getMaxFileSize(channelConfig)
  const sizeErr = (bytes: number) =>
    `Файл слишком большой (лимит: ${bytesToMB(maxBytes)} МБ, ваш файл: ${bytesToMB(bytes)} МБ).`
  const fail = async (text: string): Promise<{ ok: false }> => {
    await replyOn(text)
    return { ok: false }
  }

  if (attachment.size > maxBytes) {
    logger.info(`[trueconf] Attachment size ${attachment.size} > cap ${maxBytes} (envelope)`)
    return fail(sizeErr(attachment.size))
  }
  if (attachment.readyState === FileReadyState.NOT_AVAILABLE) {
    logger.info(`[trueconf] Attachment ${attachment.fileId} NOT_AVAILABLE (envelope)`)
    return fail(ERR_NOT_AVAILABLE)
  }

  try {
    let infoResp: Awaited<ReturnType<WsClient['sendRequest']>>
    try {
      infoResp = await wsClient.sendRequest('getFileInfo', { fileId: attachment.fileId })
    } catch (err) {
      logger.warn(`[trueconf] getFileInfo failed: ${err instanceof Error ? err.message : String(err)}`)
      return fail(ERR_GENERIC)
    }
    const errorCode = typeof infoResp.payload?.errorCode === 'number' ? infoResp.payload.errorCode : undefined
    if (errorCode !== undefined && errorCode !== 0) {
      logger.warn(`[trueconf] getFileInfo errorCode ${errorCode}`)
      return fail(ERR_GENERIC)
    }

    const initialInfo = infoResp.payload as unknown as FileInfo
    logger.info(
      `[trueconf] getFileInfo: readyState=${initialInfo.readyState} size=${initialInfo.size} downloadUrl=${initialInfo.downloadUrl ? 'present' : 'null'}`,
    )

    if (typeof initialInfo.size === 'number' && initialInfo.size > maxBytes) {
      logger.info(`[trueconf] Attachment size ${initialInfo.size} > cap ${maxBytes} (FileInfo)`)
      return fail(sizeErr(initialInfo.size ?? attachment.size))
    }
    if (initialInfo.readyState === FileReadyState.NOT_AVAILABLE) return fail(ERR_NOT_AVAILABLE)

    const rewriteUrlForAccount = (url: string): string => {
      try {
        const account = resolveAccount(channelConfig, accountId)
        if (account.serverUrl) {
          const parsed = new URL(url)
          parsed.protocol = account.useTls ? 'https:' : 'http:'
          parsed.host = hostPort({ serverUrl: account.serverUrl, useTls: account.useTls ?? false, port: account.port })
          return parsed.toString()
        }
      } catch (err) {
        logger.warn(
          `[trueconf] rewriteDownloadUrl: ${err instanceof Error ? err.message : String(err)} — using original URL`,
        )
      }
      return url
    }

    let finalInfo: FileInfo = initialInfo
    if (initialInfo.readyState !== FileReadyState.READY || initialInfo.downloadUrl == null) {
      const expectedSize = typeof initialInfo.size === 'number' && initialInfo.size > 0
        ? initialInfo.size
        : attachment.size
      const wait = await waitUploadComplete(wsClient, attachment.fileId, expectedSize, 60_000, logger)
      if (!wait.ok) {
        return fail(
          wait.reason === 'timeout'
            ? 'Файл не успел загрузиться за 60 секунд. Попробуйте ещё раз.'
            : ERR_GENERIC,
        )
      }
      const ready = await pollForReady(wsClient, attachment.fileId, 10_000, logger)
      if (!ready) {
        logger.warn(`[trueconf] upload complete but file never reached READY (fileId=${attachment.fileId})`)
        return fail(ERR_GENERIC)
      }
      finalInfo = ready
    }

    if (finalInfo.downloadUrl == null) {
      logger.warn('[trueconf] final FileInfo.downloadUrl is null')
      return fail(ERR_GENERIC)
    }

    const { tempPath, sanitizedOriginalName } = buildSanitizedTempPath(attachment.name)
    logger.info(`[trueconf] attachment tempPath: ${tempPath}`)
    await ensureAttachmentDirExists(logger)

    const dlResult = await downloadFile(rewriteUrlForAccount(finalInfo.downloadUrl), tempPath, maxBytes, logger)
    if (!dlResult.ok) {
      logger.warn(`[trueconf] downloadFile failed: ${dlResult.error}`)
      return fail(
        dlResult.error === 'invalid_url_scheme'
          ? 'Недопустимый URL файла — попробуйте ещё раз.'
          : 'Не удалось скачать файл — попробуйте ещё раз.',
      )
    }

    const finalMimeType = finalInfo.mimeType || attachment.mimeType || 'application/octet-stream'
    const kind: MediaKind = kindFromMime(finalMimeType) ?? 'document'
    const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1)
    return {
      ok: true,
      tempPath,
      sanitizedName: sanitizedOriginalName,
      mimeType: finalMimeType,
      kindLabel,
      size: finalInfo.size,
    }
  } catch (err) {
    logger.error(`[trueconf] prepareInboundAttachment: unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    await replyOn(ERR_GENERIC)
    return { ok: false }
  }
}

export async function unlinkTempFile(tempPath: string, logger: Logger): Promise<void> {
  try {
    await unlink(tempPath)
  } catch (err) {
    logger.warn(
      `[trueconf] Failed to unlink temp file ${tempPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
