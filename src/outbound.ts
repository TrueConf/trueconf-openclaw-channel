import { loadOutboundMediaFromUrl } from './load-media'
import { kindFromMime, type MediaKind } from 'openclaw/plugin-sdk/media-runtime'
import sharp from 'sharp'
import type { Dispatcher } from 'undici'
import { ErrorCode } from './types'
import type { Logger, TrueConfChannelConfig, TrueConfResponse } from './types'
import { hostPort } from './ws-client'
import {
  CAPTION_LIMIT,
  bytesToMB,
  checkTextLength,
  splitTextForSending,
  type FileUploadLimits,
} from './limits'
import type { PerChatSendQueue } from './send-queue'
import type { OutboundQueue } from './outbound-queue'
import { basename } from 'node:path'

const PREVIEW_MAX_SIDE = 512
const PREVIEW_QUALITY = 70

// TrueConf renders an attachment inline (as a photo) only when the multipart
// upload carries a `preview` WebP alongside the main `file` field; otherwise
// it lands as a downloadable document. For image MIMEs we downscale the
// original into a small WebP via sharp. Failure is non-fatal: we fall back to
// document rendering rather than blocking the send.
async function buildImagePreview(
  buffer: Buffer,
  mimeType: string,
  logger: Logger,
): Promise<Buffer | null> {
  if (!mimeType.startsWith('image/')) return null
  try {
    return await sharp(buffer, { failOn: 'none' })
      .resize(PREVIEW_MAX_SIDE, PREVIEW_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: PREVIEW_QUALITY })
      .toBuffer()
  } catch (err) {
    logger.warn(
      `[trueconf] preview generation failed; falling back to document: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

export interface DirectChatStore {
  directChatsByStableUserId: Map<string, string>
}

function directKey(accountId: string, stableUserId: string): string {
  return `${accountId}\u0000${stableUserId}`
}

function validateId(kind: string, value: string): string {
  if (!value) throw new Error(`${kind}: must not be empty`)
  if (value.includes('\u0000')) throw new Error(`${kind}: must not contain NUL byte`)
  return value
}

function normalizeUserId(value: string): string {
  return validateId('userId', value.replace(/\/.*$/, '').trim())
}

function normalizeAccountId(value: string): string {
  return validateId('accountId', value.trim())
}

function normalizeChatId(value: string): string {
  return validateId('chatId', value.trim())
}

function upsertDirectChat(
  store: DirectChatStore,
  accountId: string,
  stableUserId: string,
  chatId: string,
): void {
  store.directChatsByStableUserId.set(directKey(accountId, stableUserId), chatId)
}

// Used by inbound.ts:subscribeAndAwaitReady to classify a direct
// wsClient.sendRequest failure (bypasses OutboundQueue) as transient or
// terminal. The OutboundQueue itself classifies via NetworkError.parkable —
// outbound.ts callers no longer need this helper because all reconnect-class
// errors are parked-then-drained inside the queue.
export function isReconnectableSendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('WebSocket is not connected') || message.startsWith('WebSocket closed:')
}

export function responseErrorCode(response: TrueConfResponse): number | undefined {
  const code = response.payload?.errorCode
  return typeof code === 'number' ? code : undefined
}

async function createP2PChat(outboundQueue: OutboundQueue, userId: string, _logger: Logger): Promise<string> {
  const response = await outboundQueue.submit('createP2PChat', { userId })
  const errorCode = responseErrorCode(response)
  if (errorCode !== undefined && errorCode !== 0) {
    const desc = response.payload?.errorDescription ?? ''
    throw new Error(`createP2PChat failed: errorCode ${errorCode}${desc ? ' - ' + desc : ''}`)
  }
  const chatId = response.payload?.chatId as string | undefined
  if (!chatId) throw new Error('createP2PChat: no chatId in response payload')
  return chatId
}

async function resolveDirectChat(
  outboundQueue: OutboundQueue,
  stableUserIdInput: string,
  logger: Logger,
  options: { directChatStore: DirectChatStore; accountId: string },
): Promise<{ stableUserId: string; chatId: string }> {
  const stableUserId = normalizeUserId(stableUserIdInput)
  const existing = options.directChatStore.directChatsByStableUserId.get(
    directKey(options.accountId, stableUserId),
  )
  if (existing) return { stableUserId, chatId: existing }
  const chatId = normalizeChatId(await createP2PChat(outboundQueue, stableUserId, logger))
  upsertDirectChat(options.directChatStore, options.accountId, stableUserId, chatId)
  return { stableUserId, chatId }
}

// TrueConf markdown is unreliable inside list items and after emoji, so strip
// emphasis markers and render links as "text (url)" rather than leaking raw
// syntax to the user. Used for short captions where paragraph breaks aren't
// meaningful — collapses `\n{2,}` to a single newline.
export function sanitizeMarkdown(text: string): string {
  let r = text.replace(/\r\n?/g, '\n')
  r = r.replace(/&lt;\s*\/?\s*br\s*\/?\s*&gt;/gi, '\n')
  r = r.replace(/<\s*\/?\s*br\s*\/?\s*>/gi, '\n')
  r = r.replace(/\n{2,}/g, '\n')
  r = r.replace(/<\/?[^>]+(>|$)/g, '')
  r = r.replace(/^#{1,6}\s+(.+)$/gm, '$1')
  r = r.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, '').trim())
  r = r.replace(/`([^`]+)`/g, '$1')
  r = r.replace(/^[\s]*[*+-]\s+/gm, '- ')
  r = r.replace(/^[\s]*(\d+)\.\s+/gm, '$1. ')
  r = r.replace(/^>\s?/gm, '')
  r = r.replace(/^[-*_]{3,}$/gm, '---')
  r = r.replace(/\*\*([\s\S]+?)\*\*/g, '$1')
  r = r.replace(/(?<![A-Za-z0-9_*])\*([^\s*][^*\n]*?[^\s*])\*(?![A-Za-z0-9_*])/g, '$1')
  r = r.replace(/~~([\s\S]+?)~~/g, '$1')
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  return r.trim()
}

// Same as `sanitizeMarkdown` but preserves single blank lines between
// paragraphs. Long agent replies often arrive with deliberate paragraph breaks;
// collapsing them to a single newline (the caption-style behavior) destroys
// readability when chunks are auto-split by `splitTextForSending`. We only
// collapse runs of 3+ consecutive newlines down to `\n\n`.
export function sanitizeMarkdownPreservingParagraphs(text: string): string {
  let r = text.replace(/\r\n?/g, '\n')
  r = r.replace(/&lt;\s*\/?\s*br\s*\/?\s*&gt;/gi, '\n')
  r = r.replace(/<\s*\/?\s*br\s*\/?\s*>/gi, '\n')
  r = r.replace(/\n{3,}/g, '\n\n')
  r = r.replace(/<\/?[^>]+(>|$)/g, '')
  r = r.replace(/^#{1,6}\s+(.+)$/gm, '$1')
  r = r.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, '').trim())
  r = r.replace(/`([^`]+)`/g, '$1')
  r = r.replace(/^[\s]*[*+-]\s+/gm, '- ')
  r = r.replace(/^[\s]*(\d+)\.\s+/gm, '$1. ')
  r = r.replace(/^>\s?/gm, '')
  r = r.replace(/^[-*_]{3,}$/gm, '---')
  r = r.replace(/\*\*([\s\S]+?)\*\*/g, '$1')
  r = r.replace(/(?<![A-Za-z0-9_*])\*([^\s*][^*\n]*?[^\s*])\*(?![A-Za-z0-9_*])/g, '$1')
  r = r.replace(/~~([\s\S]+?)~~/g, '$1')
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  return r.trim()
}

// Auto-split + per-chat queue. Each chunk is a separate `sendMessage` request
// and the loop halts on the first non-zero errorCode, returning the responses
// gathered so far. The whole chunked send runs inside a single
// `sendQueue.enqueue` so concurrent replies to the same chatId don't
// interleave their chunks on the wire. Routes through `outboundQueue.submit`
// so a reconnect-class transport failure parks the chunk until auth
// re-establishes (at-least-once delivery).
async function sendMessageRequest(
  outboundQueue: OutboundQueue,
  chatId: string,
  text: string,
  _logger: Logger,
  sendQueue: PerChatSendQueue,
): Promise<TrueConfResponse[]> {
  return sendQueue.enqueue(chatId, async () => {
    const chunks = splitTextForSending(text)
    const responses: TrueConfResponse[] = []
    for (const chunk of chunks) {
      const resp = await outboundQueue.submit('sendMessage', {
        chatId,
        content: { text: chunk, parseMode: 'markdown' },
      })
      responses.push(resp)
      const code = responseErrorCode(resp)
      if (code !== undefined && code !== 0) break
    }
    return responses
  })
}

export const __test__sendMessageRequest = sendMessageRequest

async function recreateChat(
  outboundQueue: OutboundQueue,
  store: DirectChatStore,
  accountId: string,
  stableUserId: string,
  logger: Logger,
): Promise<string> {
  store.directChatsByStableUserId.delete(directKey(accountId, stableUserId))
  const chatId = normalizeChatId(await createP2PChat(outboundQueue, stableUserId, logger))
  upsertDirectChat(store, accountId, stableUserId, chatId)
  return chatId
}

type SendTextOptions = {
  fallbackUserId: string
  directChatStore: DirectChatStore
  accountId?: string
  sendQueue: PerChatSendQueue
  outboundQueue: OutboundQueue
}

export type SendTextResult =
  | { ok: false }
  | { ok: true; messageId?: string; chatId: string }

// Picks the last response from a multi-chunk send for caller error-check and
// messageId extraction. Returns `undefined` if the loop never produced a
// response (e.g., empty chunk list — `splitTextForSending` always returns at
// least one element so this is defensive).
function lastResponse(responses: TrueConfResponse[]): TrueConfResponse | undefined {
  return responses.length > 0 ? responses[responses.length - 1] : undefined
}

// Direct chatId send: no P2P resolution, no 304-repair. Used for groups where
// the chatId is authoritative and we can't recreate the chat.
export async function sendTextToChat(
  outboundQueue: OutboundQueue,
  chatId: string,
  text: string,
  logger: Logger,
  sendQueue: PerChatSendQueue,
): Promise<SendTextResult> {
  try {
    const cleanText = sanitizeMarkdownPreservingParagraphs(text)
    const safeChatId = normalizeChatId(chatId)
    const responses = await sendMessageRequest(outboundQueue, safeChatId, cleanText, logger, sendQueue)
    const last = lastResponse(responses)
    if (!last) {
      logger.error(`[trueconf] sendTextToChat: no responses returned (chatId=${safeChatId})`)
      return { ok: false }
    }
    const errorCode = responseErrorCode(last)
    if (errorCode !== undefined && errorCode !== 0) {
      const desc = last.payload?.errorDescription ?? ''
      logger.error(`[trueconf] sendTextToChat failed: errorCode ${errorCode} ${desc} (chatId=${safeChatId})`)
      return { ok: false }
    }
    return { ok: true, messageId: (last.payload?.messageId as string) ?? undefined, chatId: safeChatId }
  } catch (err) {
    logger.error(`[trueconf] sendTextToChat failed: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false }
  }
}

// Resolves stableUserId → chatId via registry, falls back to createP2PChat on
// miss, and performs exactly one 304-repair cycle on a stale entry.
export async function sendText(
  userId: string,
  text: string,
  logger: Logger,
  options: SendTextOptions,
): Promise<SendTextResult> {
  try {
    const cleanText = sanitizeMarkdownPreservingParagraphs(text)
    const accountId = normalizeAccountId(options.accountId ?? 'default')
    if (!options.accountId) {
      logger.warn('[trueconf] sendText: accountId missing, falling back to "default"')
    }
    const resolved = await resolveDirectChat(options.outboundQueue, options.fallbackUserId ?? userId, logger, {
      directChatStore: options.directChatStore,
      accountId,
    })
    let activeChatId = resolved.chatId
    let responses = await sendMessageRequest(options.outboundQueue, activeChatId, cleanText, logger, options.sendQueue)
    let last = lastResponse(responses)
    let errorCode = last ? responseErrorCode(last) : undefined
    let repaired = false

    if (errorCode === ErrorCode.CHAT_NOT_FOUND) {
      logger.warn(
        `[trueconf] sendText chat ${activeChatId} not found for ${resolved.stableUserId}; recreating P2P chat and retrying once`,
      )
      repaired = true
      activeChatId = await recreateChat(options.outboundQueue, options.directChatStore, accountId, resolved.stableUserId, logger)
      responses = await sendMessageRequest(options.outboundQueue, activeChatId, cleanText, logger, options.sendQueue)
      last = lastResponse(responses)
      errorCode = last ? responseErrorCode(last) : undefined
    }

    if (!last) {
      logger.error(`[trueconf] sendText: no responses returned (account=${accountId} stableUserId=${resolved.stableUserId})`)
      return { ok: false }
    }

    if (errorCode !== undefined && errorCode !== 0) {
      const desc = last.payload?.errorDescription ?? ''
      logger.error(
        repaired
          ? `[trueconf] sendText failed AFTER 304 repair cycle: errorCode ${errorCode} ${desc} (account=${accountId} stableUserId=${resolved.stableUserId} chatId=${activeChatId})`
          : `[trueconf] sendText failed: errorCode ${errorCode} ${desc}`,
      )
      return { ok: false }
    }
    return { ok: true, messageId: (last.payload?.messageId as string) ?? undefined, chatId: activeChatId }
  } catch (err) {
    logger.error(`[trueconf] sendText failed: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false }
  }
}

function buildBridgeApiUrl(config: { serverUrl: string; useTls: boolean; port?: number }, path: string): string {
  return `${config.useTls ? 'https' : 'http'}://${hostPort(config)}${path}`
}

async function uploadBufferMultipart(params: {
  uploadUrl: string
  uploadTaskId: string
  buffer: Buffer
  mimeType: string
  fileName: string
  preview?: { buffer: Buffer; mimeType: string; fileName: string }
  logger: Logger
  dispatcher?: Dispatcher
}): Promise<{ ok: true; temporalFileId: string } | { ok: false; error: string }> {
  const { uploadUrl, uploadTaskId, buffer, mimeType, fileName, preview, logger, dispatcher } = params

  let parsedUrl: URL
  try {
    parsedUrl = new URL(uploadUrl)
  } catch {
    return { ok: false, error: 'invalid_url_scheme' }
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return { ok: false, error: 'invalid_url_scheme' }
  }

  // Zero-copy view satisfies BlobPart; @types/node 22 types Buffer as
  // Buffer<ArrayBufferLike> which isn't assignable to BlobPart directly.
  const view = new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength)
  const formData = new FormData()
  formData.append('file', new Blob([view], { type: mimeType }), fileName)
  if (preview) {
    const pv = new Uint8Array(
      preview.buffer.buffer as ArrayBuffer,
      preview.buffer.byteOffset,
      preview.buffer.byteLength,
    )
    formData.append('preview', new Blob([pv], { type: preview.mimeType }), preview.fileName)
  }

  let response: Response
  try {
    // Upload-Task-Id header alone; no other auth header (verified vs Python SDK).
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Upload-Task-Id': uploadTaskId },
      body: formData,
      ...(dispatcher && { dispatcher }),
    } as RequestInit)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`[trueconf] uploadBufferMultipart: fetch failed: ${message}`)
    return { ok: false, error: `fetch failed: ${message}` }
  }

  if (!response.ok) {
    logger.warn(`[trueconf] uploadBufferMultipart: HTTP ${response.status} ${response.statusText}`)
    return { ok: false, error: `HTTP ${response.status} ${response.statusText}` }
  }

  let bodyJson: unknown
  try {
    bodyJson = await response.json()
  } catch (err) {
    return { ok: false, error: `invalid_json: ${err instanceof Error ? err.message : String(err)}` }
  }

  const temporalFileId = (bodyJson as { temporalFileId?: unknown })?.temporalFileId
  if (typeof temporalFileId !== 'string' || temporalFileId.length === 0 || temporalFileId.length > 200) {
    return { ok: false, error: 'invalid temporalFileId in response' }
  }
  return { ok: true, temporalFileId }
}

export type OutboundAttachmentReason =
  | 'fileNotFound'
  | 'tooLarge'
  | 'uploadFailed'
  | 'sendFailed'
  | 'genericError'

export interface OutboundAttachmentCtx {
  to: string
  text: string
  mediaUrl?: string
  mediaLocalRoots?: readonly string[]
  accountId?: string | null
}

export interface OutboundAttachmentDeps {
  outboundQueue: OutboundQueue
  resolved: { serverUrl: string; useTls: boolean; port?: number }
  store: DirectChatStore
  channelConfig: TrueConfChannelConfig
  logger: Logger
  dispatcher?: Dispatcher
  limits: FileUploadLimits
  sendQueue: PerChatSendQueue
}

interface PreparedUpload {
  temporalFileId: string
  inlineCaption: string | null
  kind: MediaKind
  bytes: number
  replyMessageId?: string | null
}

interface PreparedUploadFailure {
  reason: OutboundAttachmentReason
  userFacingText: string
}

// Steps 1-3 of an outbound attachment flow (load + uploadFile WS + HTTP
// multipart). Shared by the user-resolved path (handleOutboundAttachment) and
// the chatId-direct path (handleOutboundAttachmentToChat). Returns either a
// temporalFileId ready for sendFile or a structured failure the caller
// reports to the user.
async function prepareAttachmentUpload(
  ctx: Pick<OutboundAttachmentCtx, 'mediaUrl' | 'mediaLocalRoots' | 'text'>,
  deps: Pick<OutboundAttachmentDeps, 'outboundQueue' | 'resolved' | 'channelConfig' | 'logger' | 'dispatcher' | 'limits'>,
): Promise<{ ok: true; upload: PreparedUpload } | { ok: false; failure: PreparedUploadFailure }> {
  const { outboundQueue, resolved, logger, dispatcher, limits } = deps
  const maxBytes = limits.getMaxBytes()

  if (!ctx.mediaUrl) {
    logger.warn('[trueconf] sendMedia: ctx.mediaUrl missing')
    return { ok: false, failure: { reason: 'fileNotFound', userFacingText: 'Не удалось найти файл для отправки.' } }
  }

  let webMedia: Awaited<ReturnType<typeof loadOutboundMediaFromUrl>>
  try {
    webMedia = await loadOutboundMediaFromUrl(ctx.mediaUrl, { maxBytes, mediaLocalRoots: ctx.mediaLocalRoots })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const errCode = (err as { code?: unknown })?.code
    const isEnoent =
      errCode === 'ENOENT' || errCode === 'EACCES' ||
      /ENOENT|EACCES|not.*found|no such file/i.test(message)
    logger.warn(`[trueconf] sendMedia: loadOutboundMediaFromUrl failed: ${message}`)
    return {
      ok: false,
      failure: {
        reason: isEnoent ? 'fileNotFound' : 'genericError',
        userFacingText: isEnoent
          ? 'Не удалось найти файл для отправки.'
          : 'Не удалось обработать файл — попробуйте ещё раз.',
      },
    }
  }

  const buffer = webMedia.buffer
  const fileSize = buffer.byteLength
  const fileName = webMedia.fileName ?? basename(ctx.mediaUrl) ?? 'file'

  // Validate size + extension via FileUploadLimits (covers runtime-mutable
  // server pushes and per-account allow/block lists). Defensive size check
  // remains useful because `loadOutboundMediaFromUrl` may have raised if the
  // download exceeded `maxBytes` — but caller-imposed bounds and bot-imposed
  // policy can diverge (e.g., extension filter).
  const validation = limits.validateFile(fileName, fileSize)
  if (!validation.ok) {
    if (validation.reason === 'too_large') {
      const limitMB = bytesToMB(limits.getMaxBytes())
      const actualMB = bytesToMB(fileSize)
      logger.info(`[trueconf] sendMedia: validateFile too_large (${fileSize} > ${limits.getMaxBytes()})`)
      return {
        ok: false,
        failure: {
          reason: 'tooLarge',
          userFacingText: `Файл слишком большой (лимит: ${limitMB} МБ, ваш файл: ${actualMB} МБ).`,
        },
      }
    }
    logger.info(`[trueconf] sendMedia: validateFile extension_blocked (${validation.detail})`)
    return {
      ok: false,
      failure: {
        reason: 'genericError',
        userFacingText: `Расширение файла не разрешено: ${validation.detail}`,
      },
    }
  }

  const mimeType = webMedia.contentType ?? 'application/octet-stream'

  let uploadResp: TrueConfResponse
  try {
    uploadResp = await outboundQueue.submit('uploadFile', { fileSize, fileName })
  } catch (err) {
    logger.warn(`[trueconf] sendMedia step 1/3 FAIL: ${err instanceof Error ? err.message : String(err)}`)
    return {
      ok: false,
      failure: {
        reason: 'uploadFailed',
        userFacingText: 'Не удалось загрузить файл — попробуйте ещё раз.',
      },
    }
  }

  const uploadErrorCode = responseErrorCode(uploadResp)
  const uploadTaskId = uploadResp.payload?.uploadTaskId
  if ((uploadErrorCode !== undefined && uploadErrorCode !== 0) || typeof uploadTaskId !== 'string' || !uploadTaskId) {
    logger.warn(`[trueconf] sendMedia step 1/3 FAIL: errorCode=${uploadErrorCode} uploadTaskId=${String(uploadTaskId)}`)
    return { ok: false, failure: { reason: 'uploadFailed', userFacingText: 'Не удалось загрузить файл — попробуйте ещё раз.' } }
  }
  logger.info(`[trueconf] sendMedia step 1/3 OK uploadTaskId=${uploadTaskId}`)

  const previewBuffer = await buildImagePreview(buffer, mimeType, logger)
  const uploadResult = await uploadBufferMultipart({
    uploadUrl: buildBridgeApiUrl(resolved, '/bridge/api/client/v1/files'),
    uploadTaskId,
    buffer,
    mimeType,
    fileName,
    preview: previewBuffer
      ? { buffer: previewBuffer, mimeType: 'image/webp', fileName: 'preview.webp' }
      : undefined,
    logger,
    dispatcher,
  })
  if (!uploadResult.ok) {
    logger.warn(`[trueconf] sendMedia step 2/3 FAIL: ${uploadResult.error}`)
    return { ok: false, failure: { reason: 'uploadFailed', userFacingText: 'Не удалось загрузить файл — попробуйте ещё раз.' } }
  }
  const temporalFileId = uploadResult.temporalFileId
  logger.info(`[trueconf] sendMedia step 2/3 OK temporalFileId=${temporalFileId} bytes=${fileSize}`)

  const caption = sanitizeMarkdown(ctx.text ?? '').trim()
  const inlineCaption = caption.length > 0 ? caption : null
  const kind: MediaKind = kindFromMime(mimeType) ?? 'document'

  return { ok: true, upload: { temporalFileId, inlineCaption, kind, bytes: fileSize } }
}

function buildSendFilePayload(chatId: string, upload: PreparedUpload): Record<string, unknown> {
  const content: Record<string, unknown> = { temporalFileId: upload.temporalFileId }
  if (upload.inlineCaption !== null) content.caption = { text: upload.inlineCaption, parseMode: 'markdown' }
  const payload: Record<string, unknown> = { chatId, content }
  if (upload.replyMessageId != null) payload.replyMessageId = upload.replyMessageId
  return payload
}

export const __test__buildSendFilePayload = buildSendFilePayload

// If `upload.inlineCaption` exceeds the caption limit, send it first as a
// standalone `sendMessage` and then attach the file without caption. TrueConf's
// `sendFile` truncates over-limit captions server-side, so splitting the
// caption out preserves the user-visible content. The orphan case (caption
// sent, sendFile fails) is unavoidable; we log explicitly so ops can detect
// it. Returns either a mutated `upload` (caption stripped) or a structured
// failure routed back through the caller's `fail()` helper.
async function maybeSendCaptionSeparately(
  outboundQueue: OutboundQueue,
  chatId: string,
  upload: PreparedUpload,
  logger: Logger,
  sendQueue: PerChatSendQueue,
): Promise<{ ok: true; upload: PreparedUpload; captionSentSeparately: boolean } | { ok: false; failure: PreparedUploadFailure }> {
  const captionText = upload.inlineCaption
  if (captionText === null) return { ok: true, upload, captionSentSeparately: false }

  const captionCheck = checkTextLength(captionText, CAPTION_LIMIT)
  if (captionCheck.ok) return { ok: true, upload, captionSentSeparately: false }

  logger.warn(
    `[trueconf] caption too long: ${captionCheck.codePoints} > ${captionCheck.limit}; sending as separate message`,
  )
  const captionResults = await sendMessageRequest(outboundQueue, chatId, captionText, logger, sendQueue)
  const lastResult = captionResults[captionResults.length - 1]
  const captionErr = lastResult ? responseErrorCode(lastResult) : -1
  if (captionErr !== undefined && captionErr !== 0) {
    logger.error(
      `[trueconf] caption send failed (errorCode=${captionErr}); aborting attachment to avoid orphaned message`,
    )
    return {
      ok: false,
      failure: { reason: 'genericError', userFacingText: 'Не удалось отправить файл — попробуйте ещё раз.' },
    }
  }
  // Strip caption so `sendFile` payload omits it.
  return { ok: true, upload: { ...upload, inlineCaption: null }, captionSentSeparately: true }
}

export async function handleOutboundAttachment(
  ctx: OutboundAttachmentCtx,
  deps: OutboundAttachmentDeps,
): Promise<{ ok: true; messageId: string; chatId: string } | { ok: false; reason: OutboundAttachmentReason }> {
  const { outboundQueue, logger, store, sendQueue } = deps

  let stableUserId: string
  try {
    stableUserId = normalizeUserId(ctx.to)
  } catch (err) {
    logger.error(
      `[trueconf] handleOutboundAttachment: invalid ctx.to ${JSON.stringify(ctx.to)}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { ok: false, reason: 'genericError' }
  }

  if (!ctx.accountId) logger.warn('[trueconf] handleOutboundAttachment: accountId missing, falling back to "default"')
  const accountId = normalizeAccountId(ctx.accountId ?? 'default')

  const fail = async (reason: OutboundAttachmentReason, text: string): Promise<{ ok: false; reason: OutboundAttachmentReason }> => {
    await sendText(stableUserId, text, logger, {
      fallbackUserId: stableUserId,
      directChatStore: store,
      accountId,
      sendQueue,
      outboundQueue,
    })
    return { ok: false, reason }
  }

  try {
    const prepared = await prepareAttachmentUpload(ctx, deps)
    if (!prepared.ok) return fail(prepared.failure.reason, prepared.failure.userFacingText)
    let upload = prepared.upload

    let activeChatId: string
    try {
      activeChatId = (await resolveDirectChat(outboundQueue, stableUserId, logger, {
        directChatStore: store,
        accountId,
      })).chatId
    } catch (err) {
      // Skip user reply: no chat to send to. Re-entering sendText here would
      // fire createP2PChat a second time on every persistent failure.
      logger.error(`[trueconf] sendMedia direct-chat resolve FAIL: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, reason: 'sendFailed' }
    }

    const captionGate = await maybeSendCaptionSeparately(outboundQueue, activeChatId, upload, logger, sendQueue)
    if (!captionGate.ok) return fail(captionGate.failure.reason, captionGate.failure.userFacingText)
    upload = captionGate.upload
    const captionSentSeparately = captionGate.captionSentSeparately

    let sendResp: TrueConfResponse
    try {
      sendResp = await outboundQueue.submit('sendFile', buildSendFilePayload(activeChatId, upload))
    } catch (err) {
      logger.warn(`[trueconf] sendMedia step 3/3 FAIL: ${err instanceof Error ? err.message : String(err)}`)
      if (captionSentSeparately) {
        logger.error(
          `[trueconf] sendFile failed AFTER caption was already delivered as separate message; user sees orphan caption-text without attachment (chatId=${activeChatId})`,
        )
      }
      return fail('sendFailed', 'Не удалось отправить файл — попробуйте ещё раз.')
    }

    let sendErrorCode = responseErrorCode(sendResp)
    if (sendErrorCode === ErrorCode.CHAT_NOT_FOUND) {
      logger.warn(`[trueconf] sendMedia chat ${activeChatId} not found for ${stableUserId}; recreating P2P chat and retrying once`)
      try {
        activeChatId = await recreateChat(outboundQueue, store, accountId, stableUserId, logger)
        sendResp = await outboundQueue.submit('sendFile', buildSendFilePayload(activeChatId, upload))
        sendErrorCode = responseErrorCode(sendResp)
      } catch (err) {
        logger.error(`[trueconf] sendMedia 304 repair FAIL: ${err instanceof Error ? err.message : String(err)}`)
        if (captionSentSeparately) {
          logger.error(
            `[trueconf] sendFile failed AFTER caption was already delivered as separate message; user sees orphan caption-text without attachment (chatId=${activeChatId})`,
          )
        }
        return { ok: false, reason: 'sendFailed' }
      }
    }
    if (sendErrorCode !== undefined && sendErrorCode !== 0) {
      logger.warn(`[trueconf] sendMedia step 3/3 FAIL: errorCode ${sendErrorCode}`)
      if (captionSentSeparately) {
        logger.error(
          `[trueconf] sendFile failed AFTER caption was already delivered as separate message; user sees orphan caption-text without attachment (chatId=${activeChatId})`,
        )
      }
      return fail('sendFailed', 'Не удалось отправить файл — попробуйте ещё раз.')
    }

    const messageId = sendResp.payload?.messageId
    if (typeof messageId !== 'string' || !messageId) {
      logger.warn('[trueconf] sendMedia step 3/3 FAIL: response missing messageId')
      if (captionSentSeparately) {
        logger.error(
          `[trueconf] sendFile failed AFTER caption was already delivered as separate message; user sees orphan caption-text without attachment (chatId=${activeChatId})`,
        )
      }
      return fail('sendFailed', 'Не удалось отправить файл — попробуйте ещё раз.')
    }

    logger.info(`[trueconf] sendMedia step 3/3 OK messageId=${messageId} kind=${upload.kind}`)
    return { ok: true, messageId, chatId: activeChatId }
  } catch (err) {
    logger.error(`[trueconf] handleOutboundAttachment top-level: ${err instanceof Error ? err.message : String(err)}`)
    return fail('genericError', 'Не удалось обработать файл — попробуйте ещё раз.')
  }
}

export interface OutboundAttachmentToChatCtx {
  chatId: string
  text: string
  mediaUrl?: string
  mediaLocalRoots?: readonly string[]
}

export type OutboundAttachmentToChatDeps = Pick<
  OutboundAttachmentDeps,
  'outboundQueue' | 'resolved' | 'channelConfig' | 'logger' | 'dispatcher' | 'limits' | 'sendQueue'
>

// Parallel to sendTextToChat: attachment send to an authoritative chatId
// (used for groups). Skips resolveDirectChat and the 304 recreate cycle —
// groups cannot be recreated on demand, so CHAT_NOT_FOUND is terminal here.
// Error replies are routed back to the same chatId so the user actually
// sees the failure feedback in the group where they asked.
export async function handleOutboundAttachmentToChat(
  ctx: OutboundAttachmentToChatCtx,
  deps: OutboundAttachmentToChatDeps,
): Promise<{ ok: true; messageId: string; chatId: string } | { ok: false; reason: OutboundAttachmentReason }> {
  const { outboundQueue, logger, sendQueue } = deps

  let safeChatId: string
  try {
    safeChatId = normalizeChatId(ctx.chatId)
  } catch (err) {
    logger.error(
      `[trueconf] handleOutboundAttachmentToChat: invalid chatId ${JSON.stringify(ctx.chatId)}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { ok: false, reason: 'genericError' }
  }

  const fail = async (reason: OutboundAttachmentReason, text: string): Promise<{ ok: false; reason: OutboundAttachmentReason }> => {
    await sendTextToChat(outboundQueue, safeChatId, text, logger, sendQueue)
    return { ok: false, reason }
  }

  try {
    const prepared = await prepareAttachmentUpload(ctx, deps)
    if (!prepared.ok) return fail(prepared.failure.reason, prepared.failure.userFacingText)
    let upload = prepared.upload

    const captionGate = await maybeSendCaptionSeparately(outboundQueue, safeChatId, upload, logger, sendQueue)
    if (!captionGate.ok) return fail(captionGate.failure.reason, captionGate.failure.userFacingText)
    upload = captionGate.upload
    const captionSentSeparately = captionGate.captionSentSeparately

    let sendResp: TrueConfResponse
    try {
      sendResp = await outboundQueue.submit('sendFile', buildSendFilePayload(safeChatId, upload))
    } catch (err) {
      logger.warn(`[trueconf] sendMediaToChat step 3/3 FAIL: ${err instanceof Error ? err.message : String(err)}`)
      if (captionSentSeparately) {
        logger.error(
          `[trueconf] sendFile failed AFTER caption was already delivered as separate message; user sees orphan caption-text without attachment (chatId=${safeChatId})`,
        )
      }
      return fail('sendFailed', 'Не удалось отправить файл — попробуйте ещё раз.')
    }

    const sendErrorCode = responseErrorCode(sendResp)
    if (sendErrorCode !== undefined && sendErrorCode !== 0) {
      logger.warn(`[trueconf] sendMediaToChat step 3/3 FAIL: errorCode ${sendErrorCode} (chatId=${safeChatId})`)
      if (captionSentSeparately) {
        logger.error(
          `[trueconf] sendFile failed AFTER caption was already delivered as separate message; user sees orphan caption-text without attachment (chatId=${safeChatId})`,
        )
      }
      return fail('sendFailed', 'Не удалось отправить файл — попробуйте ещё раз.')
    }

    const messageId = sendResp.payload?.messageId
    if (typeof messageId !== 'string' || !messageId) {
      logger.warn('[trueconf] sendMediaToChat step 3/3 FAIL: response missing messageId')
      if (captionSentSeparately) {
        logger.error(
          `[trueconf] sendFile failed AFTER caption was already delivered as separate message; user sees orphan caption-text without attachment (chatId=${safeChatId})`,
        )
      }
      return fail('sendFailed', 'Не удалось отправить файл — попробуйте ещё раз.')
    }

    logger.info(`[trueconf] sendMediaToChat step 3/3 OK messageId=${messageId} kind=${upload.kind} chatId=${safeChatId}`)
    return { ok: true, messageId, chatId: safeChatId }
  } catch (err) {
    logger.error(`[trueconf] handleOutboundAttachmentToChat top-level: ${err instanceof Error ? err.message : String(err)}`)
    return fail('genericError', 'Не удалось обработать файл — попробуйте ещё раз.')
  }
}
