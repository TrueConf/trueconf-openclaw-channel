import { loadOutboundMediaFromUrl } from 'openclaw/plugin-sdk/mattermost'
import { kindFromMime, type MediaKind } from 'openclaw/plugin-sdk/media-runtime'
import sharp from 'sharp'
import type { Dispatcher } from 'undici'
import { ErrorCode } from './types'
import type { Logger, TrueConfChannelConfig, TrueConfResponse } from './types'
import { WsClient, hostPort } from './ws-client'
import { getMaxFileSize } from './inbound'
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

const DISCONNECTED_RETRY_DELAYS_MS = [1_000, 2_000] as const
const bytesToMB = (n: number): number => (n > 0 ? Math.ceil(n / (1024 * 1024)) : 0)

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

export function isReconnectableSendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('WebSocket is not connected') || message.startsWith('WebSocket closed:')
}

export async function sendRequestWithReconnectRetry(
  client: WsClient,
  method: string,
  payload: Record<string, unknown>,
  logger: Logger,
): Promise<TrueConfResponse> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= DISCONNECTED_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delayMs = DISCONNECTED_RETRY_DELAYS_MS[attempt - 1]
      logger.warn(`[trueconf] ${method} retrying after reconnect wait (${delayMs}ms)`)
      await new Promise<void>((r) => setTimeout(r, delayMs))
    }
    try {
      return await client.sendRequest(method, payload)
    } catch (err) {
      lastError = err
      if (!isReconnectableSendError(err) || attempt === DISCONNECTED_RETRY_DELAYS_MS.length) throw err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function responseErrorCode(response: TrueConfResponse): number | undefined {
  const code = response.payload?.errorCode
  return typeof code === 'number' ? code : undefined
}

async function createP2PChat(client: WsClient, userId: string, logger: Logger): Promise<string> {
  const response = await sendRequestWithReconnectRetry(client, 'createP2PChat', { userId }, logger)
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
  client: WsClient,
  stableUserIdInput: string,
  logger: Logger,
  options: { directChatStore: DirectChatStore; accountId: string },
): Promise<{ stableUserId: string; chatId: string }> {
  const stableUserId = normalizeUserId(stableUserIdInput)
  const existing = options.directChatStore.directChatsByStableUserId.get(
    directKey(options.accountId, stableUserId),
  )
  if (existing) return { stableUserId, chatId: existing }
  const chatId = normalizeChatId(await createP2PChat(client, stableUserId, logger))
  upsertDirectChat(options.directChatStore, options.accountId, stableUserId, chatId)
  return { stableUserId, chatId }
}

// TrueConf markdown is unreliable inside list items and after emoji, so strip
// emphasis markers and render links as "text (url)" rather than leaking raw
// syntax to the user.
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

async function sendMessageRequest(
  client: WsClient,
  chatId: string,
  text: string,
  logger: Logger,
): Promise<TrueConfResponse> {
  return sendRequestWithReconnectRetry(client, 'sendMessage', {
    chatId,
    content: { text, parseMode: 'markdown' },
  }, logger)
}

async function recreateChat(
  client: WsClient,
  store: DirectChatStore,
  accountId: string,
  stableUserId: string,
  logger: Logger,
): Promise<string> {
  store.directChatsByStableUserId.delete(directKey(accountId, stableUserId))
  const chatId = normalizeChatId(await createP2PChat(client, stableUserId, logger))
  upsertDirectChat(store, accountId, stableUserId, chatId)
  return chatId
}

type SendTextOptions = {
  fallbackUserId: string
  directChatStore: DirectChatStore
  accountId?: string
}

export type SendTextResult =
  | { ok: false }
  | { ok: true; messageId?: string; chatId: string }

// Direct chatId send: no P2P resolution, no 304-repair. Used for groups where
// the chatId is authoritative and we can't recreate the chat.
export async function sendTextToChat(
  client: WsClient,
  chatId: string,
  text: string,
  logger: Logger,
): Promise<SendTextResult> {
  try {
    const cleanText = sanitizeMarkdown(text)
    const safeChatId = normalizeChatId(chatId)
    const response = await sendMessageRequest(client, safeChatId, cleanText, logger)
    const errorCode = responseErrorCode(response)
    if (errorCode !== undefined && errorCode !== 0) {
      const desc = response.payload?.errorDescription ?? ''
      logger.error(`[trueconf] sendTextToChat failed: errorCode ${errorCode} ${desc} (chatId=${safeChatId})`)
      return { ok: false }
    }
    return { ok: true, messageId: (response.payload?.messageId as string) ?? undefined, chatId: safeChatId }
  } catch (err) {
    logger.error(`[trueconf] sendTextToChat failed: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false }
  }
}

// Resolves stableUserId → chatId via registry, falls back to createP2PChat on
// miss, and performs exactly one 304-repair cycle on a stale entry.
export async function sendText(
  client: WsClient,
  userId: string,
  text: string,
  logger: Logger,
  options: SendTextOptions,
): Promise<SendTextResult> {
  try {
    const cleanText = sanitizeMarkdown(text)
    const accountId = normalizeAccountId(options.accountId ?? 'default')
    if (!options.accountId) {
      logger.warn('[trueconf] sendText: accountId missing, falling back to "default"')
    }
    const resolved = await resolveDirectChat(client, options.fallbackUserId ?? userId, logger, {
      directChatStore: options.directChatStore,
      accountId,
    })
    let activeChatId = resolved.chatId
    let response = await sendMessageRequest(client, activeChatId, cleanText, logger)
    let errorCode = responseErrorCode(response)
    let repaired = false

    if (errorCode === ErrorCode.CHAT_NOT_FOUND) {
      logger.warn(
        `[trueconf] sendText chat ${activeChatId} not found for ${resolved.stableUserId}; recreating P2P chat and retrying once`,
      )
      repaired = true
      activeChatId = await recreateChat(client, options.directChatStore, accountId, resolved.stableUserId, logger)
      response = await sendMessageRequest(client, activeChatId, cleanText, logger)
      errorCode = responseErrorCode(response)
    }

    if (errorCode !== undefined && errorCode !== 0) {
      const desc = response.payload?.errorDescription ?? ''
      logger.error(
        repaired
          ? `[trueconf] sendText failed AFTER 304 repair cycle: errorCode ${errorCode} ${desc} (account=${accountId} stableUserId=${resolved.stableUserId} chatId=${activeChatId})`
          : `[trueconf] sendText failed: errorCode ${errorCode} ${desc}`,
      )
      return { ok: false }
    }
    return { ok: true, messageId: (response.payload?.messageId as string) ?? undefined, chatId: activeChatId }
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
  | 'reconnect'
  | 'genericError'

export interface OutboundAttachmentCtx {
  to: string
  text: string
  mediaUrl?: string
  mediaLocalRoots?: readonly string[]
  accountId?: string | null
}

export interface OutboundAttachmentDeps {
  wsClient: WsClient
  resolved: { serverUrl: string; useTls: boolean; port?: number }
  store: DirectChatStore
  channelConfig: TrueConfChannelConfig
  logger: Logger
  dispatcher?: Dispatcher
}

interface PreparedUpload {
  temporalFileId: string
  inlineCaption: string | null
  kind: MediaKind
  bytes: number
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
  deps: Pick<OutboundAttachmentDeps, 'wsClient' | 'resolved' | 'channelConfig' | 'logger' | 'dispatcher'>,
): Promise<{ ok: true; upload: PreparedUpload } | { ok: false; failure: PreparedUploadFailure }> {
  const { wsClient, resolved, channelConfig, logger, dispatcher } = deps
  const maxBytes = getMaxFileSize(channelConfig)

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
  if (fileSize > maxBytes) {
    logger.info(`[trueconf] sendMedia: buffer ${fileSize} > cap ${maxBytes}`)
    return {
      ok: false,
      failure: {
        reason: 'tooLarge',
        userFacingText: `Файл слишком большой (лимит: ${bytesToMB(maxBytes)} МБ, ваш файл: ${bytesToMB(fileSize)} МБ).`,
      },
    }
  }

  const mimeType = webMedia.contentType ?? 'application/octet-stream'
  const fileName = webMedia.fileName ?? basename(ctx.mediaUrl) ?? 'file'

  let uploadResp: TrueConfResponse
  try {
    uploadResp = await wsClient.sendRequest('uploadFile', { fileSize, fileName })
  } catch (err) {
    const isReconnect = isReconnectableSendError(err)
    logger.warn(`[trueconf] sendMedia step 1/3 FAIL: ${err instanceof Error ? err.message : String(err)}`)
    return {
      ok: false,
      failure: {
        reason: isReconnect ? 'reconnect' : 'uploadFailed',
        userFacingText: isReconnect
          ? 'Соединение прервалось — попробуйте ещё раз.'
          : 'Не удалось загрузить файл — попробуйте ещё раз.',
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
  return { chatId, replyMessageId: null, content }
}

export async function handleOutboundAttachment(
  ctx: OutboundAttachmentCtx,
  deps: OutboundAttachmentDeps,
): Promise<{ ok: true; messageId: string; chatId: string } | { ok: false; reason: OutboundAttachmentReason }> {
  const { wsClient, logger, store } = deps

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
    await sendText(wsClient, stableUserId, text, logger, {
      fallbackUserId: stableUserId,
      directChatStore: store,
      accountId,
    })
    return { ok: false, reason }
  }

  try {
    const prepared = await prepareAttachmentUpload(ctx, deps)
    if (!prepared.ok) return fail(prepared.failure.reason, prepared.failure.userFacingText)
    const upload = prepared.upload

    let activeChatId: string
    try {
      activeChatId = (await resolveDirectChat(wsClient, stableUserId, logger, {
        directChatStore: store,
        accountId,
      })).chatId
    } catch (err) {
      const isReconnect = isReconnectableSendError(err)
      // Skip user reply: no chat to send to. Re-entering sendText here would
      // fire createP2PChat a second time on every persistent failure.
      logger.error(`[trueconf] sendMedia direct-chat resolve FAIL: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, reason: isReconnect ? 'reconnect' : 'sendFailed' }
    }

    let sendResp: TrueConfResponse
    try {
      sendResp = await sendRequestWithReconnectRetry(wsClient, 'sendFile', buildSendFilePayload(activeChatId, upload), logger)
    } catch (err) {
      const isReconnect = isReconnectableSendError(err)
      logger.warn(`[trueconf] sendMedia step 3/3 FAIL after retries: ${err instanceof Error ? err.message : String(err)}`)
      return fail(
        isReconnect ? 'reconnect' : 'sendFailed',
        isReconnect ? 'Соединение прервалось — попробуйте ещё раз.' : 'Не удалось отправить файл — попробуйте ещё раз.',
      )
    }

    let sendErrorCode = responseErrorCode(sendResp)
    if (sendErrorCode === ErrorCode.CHAT_NOT_FOUND) {
      logger.warn(`[trueconf] sendMedia chat ${activeChatId} not found for ${stableUserId}; recreating P2P chat and retrying once`)
      try {
        activeChatId = await recreateChat(wsClient, store, accountId, stableUserId, logger)
        sendResp = await sendRequestWithReconnectRetry(wsClient, 'sendFile', buildSendFilePayload(activeChatId, upload), logger)
        sendErrorCode = responseErrorCode(sendResp)
      } catch (err) {
        const isReconnect = isReconnectableSendError(err)
        logger.error(`[trueconf] sendMedia 304 repair FAIL: ${err instanceof Error ? err.message : String(err)}`)
        return { ok: false, reason: isReconnect ? 'reconnect' : 'sendFailed' }
      }
    }
    if (sendErrorCode !== undefined && sendErrorCode !== 0) {
      logger.warn(`[trueconf] sendMedia step 3/3 FAIL: errorCode ${sendErrorCode}`)
      return fail('sendFailed', 'Не удалось отправить файл — попробуйте ещё раз.')
    }

    const messageId = sendResp.payload?.messageId
    if (typeof messageId !== 'string' || !messageId) {
      logger.warn('[trueconf] sendMedia step 3/3 FAIL: response missing messageId')
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
  'wsClient' | 'resolved' | 'channelConfig' | 'logger' | 'dispatcher'
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
  const { wsClient, logger } = deps

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
    await sendTextToChat(wsClient, safeChatId, text, logger)
    return { ok: false, reason }
  }

  try {
    const prepared = await prepareAttachmentUpload(ctx, deps)
    if (!prepared.ok) return fail(prepared.failure.reason, prepared.failure.userFacingText)
    const upload = prepared.upload

    let sendResp: TrueConfResponse
    try {
      sendResp = await sendRequestWithReconnectRetry(wsClient, 'sendFile', buildSendFilePayload(safeChatId, upload), logger)
    } catch (err) {
      const isReconnect = isReconnectableSendError(err)
      logger.warn(`[trueconf] sendMediaToChat step 3/3 FAIL after retries: ${err instanceof Error ? err.message : String(err)}`)
      return fail(
        isReconnect ? 'reconnect' : 'sendFailed',
        isReconnect ? 'Соединение прервалось — попробуйте ещё раз.' : 'Не удалось отправить файл — попробуйте ещё раз.',
      )
    }

    const sendErrorCode = responseErrorCode(sendResp)
    if (sendErrorCode !== undefined && sendErrorCode !== 0) {
      logger.warn(`[trueconf] sendMediaToChat step 3/3 FAIL: errorCode ${sendErrorCode} (chatId=${safeChatId})`)
      return fail('sendFailed', 'Не удалось отправить файл — попробуйте ещё раз.')
    }

    const messageId = sendResp.payload?.messageId
    if (typeof messageId !== 'string' || !messageId) {
      logger.warn('[trueconf] sendMediaToChat step 3/3 FAIL: response missing messageId')
      return fail('sendFailed', 'Не удалось отправить файл — попробуйте ещё раз.')
    }

    logger.info(`[trueconf] sendMediaToChat step 3/3 OK messageId=${messageId} kind=${upload.kind} chatId=${safeChatId}`)
    return { ok: true, messageId, chatId: safeChatId }
  } catch (err) {
    logger.error(`[trueconf] handleOutboundAttachmentToChat top-level: ${err instanceof Error ? err.message : String(err)}`)
    return fail('genericError', 'Не удалось обработать файл — попробуйте ещё раз.')
  }
}
