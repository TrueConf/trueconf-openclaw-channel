import type { FileUploadLimits } from './limits'
import type { Logger } from './types'

/**
 * Discriminated union of chat-mutation push events. INTERNAL — declared here so
 * the parsed-and-dropped handlers below can share a vocabulary with the future
 * phase-1 callback API. Not exported in v1.2.0; phase-1 PR will export it and
 * wire `setChatMutationHandler(...)` on the channel.
 *
 * Keeping the shape pinned now means phase-1 only has to add a callback field
 * to `PushEventContext` and replace the `logger.info` summaries with a
 * dispatch — handler validation contracts stay identical.
 */
type ChatMutationEvent =
  | { kind: 'messageEdited'; chatId: string; timestamp: number; newContent: { text: string; parseMode?: string } }
  | { kind: 'messageRemoved'; chatId: string; messageId: string; removedBy?: { id: string; type: number } }
  | { kind: 'chatHistoryCleared'; chatId: string; forAll: boolean }

export interface PushEventContext {
  readonly limits: FileUploadLimits
  readonly invalidateChatState: (chatId: string) => void
  readonly logger: Logger
}

/**
 * Bounded LRU set for de-duplicating "unknown push method" log entries.
 *
 * Prevents log flooding when an unrecognized server-pushed method arrives
 * repeatedly. FIFO eviction once `capacity` is reached — re-adding an evicted
 * entry treats it as new and re-logs once.
 */
class BoundedSeen {
  private readonly set = new Set<string>()
  private readonly fifo: string[] = []

  constructor(private readonly capacity: number = 32) {}

  /** true if `key` was already present, false if it was just added. */
  hasOrAdd(key: string): boolean {
    if (this.set.has(key)) return true
    this.set.add(key)
    this.fifo.push(key)
    if (this.fifo.length > this.capacity) {
      const evicted = this.fifo.shift()
      if (evicted !== undefined) this.set.delete(evicted)
    }
    return false
  }
}

const seenUnknownMethods = new BoundedSeen(32)

/**
 * Routes a server-pushed type=1 event to the correct handler.
 *
 * Returns `true` if the method was recognized and handled (even if validation
 * failed — a recognized but malformed payload still consumes the event), and
 * `false` if the method is unknown to this SDK.
 *
 * NOTE: `sendMessage` and `uploadFileProgress` are NOT handled here —
 * `inbound.ts` and `ws-client.ts` (progress handlers) own those respectively.
 */
export function handleSdkPushEvent(method: string, payload: unknown, ctx: PushEventContext): boolean {
  switch (method) {
    case 'getFileUploadLimits':
      return handleGetFileUploadLimits(payload, ctx)
    case 'removeChat':
      return handleRemoveChat(payload, ctx)
    case 'editMessage':
      return handleEditMessage(payload, ctx)
    case 'removeMessage':
      return handleRemoveMessage(payload, ctx)
    case 'clearHistory':
      return handleClearHistory(payload, ctx)
    default:
      handleUnknown(method, ctx)
      return false
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function handleGetFileUploadLimits(payload: unknown, ctx: PushEventContext): true {
  // The method ALWAYS forwards — `FileUploadLimits` itself does corrupt-payload
  // handling (validate + log + no-op on bad shape).
  if (!isObject(payload)) {
    ctx.logger.warn(`[trueconf] getFileUploadLimits: payload is not an object, ignoring`)
    return true
  }
  ctx.limits.updateFromServer(payload)
  return true
}

function handleRemoveChat(payload: unknown, ctx: PushEventContext): true {
  if (!isObject(payload) || !isNonEmptyString(payload['chatId'])) {
    ctx.logger.warn(`[trueconf] removeChat: missing or invalid chatId, ignoring`)
    return true
  }
  ctx.invalidateChatState(payload['chatId'])
  return true
}

function handleEditMessage(payload: unknown, ctx: PushEventContext): true {
  if (!isObject(payload)) {
    ctx.logger.warn(`[trueconf] editMessage: payload is not an object, ignoring`)
    return true
  }
  const chatId = payload['chatId']
  const timestamp = payload['timestamp']
  // Wire field is `content` (matches python-trueconf-bot
  // trueconf/types/requests/edited_message.py: `content: TextContent`). The
  // internal ChatMutationEvent uses `newContent` to convey post-edit semantics —
  // these are different layers and must not be conflated.
  const content = payload['content']
  if (
    !isNonEmptyString(chatId)
    || typeof timestamp !== 'number'
    || !Number.isFinite(timestamp)
    || !isObject(content)
    || typeof content['text'] !== 'string'
  ) {
    ctx.logger.warn(`[trueconf] editMessage: invalid payload shape, ignoring`)
    return true
  }
  // Construct the ChatMutationEvent variant a phase-1 callback would receive.
  // We log a summary and drop it here — phase-1 PR will swap the drop for a dispatch.
  const event: ChatMutationEvent = {
    kind: 'messageEdited',
    chatId,
    timestamp,
    newContent: {
      text: content['text'],
      ...(typeof content['parseMode'] === 'string' ? { parseMode: content['parseMode'] } : {}),
    },
  }
  ctx.logger.info(`[trueconf] ${event.kind} parsed-and-dropped (chatId=${event.chatId}, ts=${event.timestamp})`)
  return true
}

function handleRemoveMessage(payload: unknown, ctx: PushEventContext): true {
  if (!isObject(payload)) {
    ctx.logger.warn(`[trueconf] removeMessage: payload is not an object, ignoring`)
    return true
  }
  const chatId = payload['chatId']
  const messageId = payload['messageId']
  if (!isNonEmptyString(chatId) || !isNonEmptyString(messageId)) {
    ctx.logger.warn(`[trueconf] removeMessage: missing or invalid chatId/messageId, ignoring`)
    return true
  }
  // removedBy is optional; if present, validate shape but still proceed (parsed-and-dropped).
  const rawRemovedBy = payload['removedBy']
  let removedBy: { id: string; type: number } | undefined
  if (rawRemovedBy !== undefined) {
    if (
      !isObject(rawRemovedBy)
      || typeof rawRemovedBy['id'] !== 'string'
      || typeof rawRemovedBy['type'] !== 'number'
    ) {
      ctx.logger.warn(`[trueconf] removeMessage: invalid removedBy shape, ignoring`)
      return true
    }
    removedBy = { id: rawRemovedBy['id'], type: rawRemovedBy['type'] }
  }
  const event: ChatMutationEvent = {
    kind: 'messageRemoved',
    chatId,
    messageId,
    ...(removedBy ? { removedBy } : {}),
  }
  ctx.logger.info(
    `[trueconf] ${event.kind} parsed-and-dropped (chatId=${event.chatId}, messageId=${event.messageId})`,
  )
  return true
}

function handleClearHistory(payload: unknown, ctx: PushEventContext): true {
  if (!isObject(payload)) {
    ctx.logger.warn(`[trueconf] clearHistory: payload is not an object, ignoring`)
    return true
  }
  const chatId = payload['chatId']
  if (!isNonEmptyString(chatId)) {
    ctx.logger.warn(`[trueconf] clearHistory: missing or invalid chatId, ignoring`)
    return true
  }
  // Python sometimes serialises booleans as the literal string "true". Coerce
  // both forms so downstream consumers (current logger summary, future
  // callback) see a real boolean.
  const forAll = payload['forAll'] === true || payload['forAll'] === 'true'
  const event: ChatMutationEvent = { kind: 'chatHistoryCleared', chatId, forAll }
  ctx.logger.info(
    `[trueconf] ${event.kind} parsed-and-dropped (chatId=${event.chatId}, forAll=${event.forAll})`,
  )
  return true
}

function handleUnknown(method: string, ctx: PushEventContext): void {
  if (seenUnknownMethods.hasOrAdd(method)) return
  ctx.logger.info(`[trueconf] unknown push method: ${method}`)
}
