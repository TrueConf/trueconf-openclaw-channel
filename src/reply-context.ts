import type { WsClient } from './ws-client'
import { EnvelopeType } from './types'

const MAX_QUOTE_LEN = 500

// Builds the human-readable prefix prepended to an inbound message that quotes
// another message, so the agent sees the quoted author + text it is replying
// to. Whitespace is collapsed and long quotes are truncated with an ellipsis.
export function formatQuotedPrefix(author: string, quotedText: string): string {
  const who = author.trim() || 'участника'
  let q = quotedText.replace(/\s+/g, ' ').trim()
  if (q.length > MAX_QUOTE_LEN) q = q.slice(0, MAX_QUOTE_LEN).trimEnd() + '…'
  return `[В ответ на сообщение от ${who}: «${q}»]`
}

function stripTags(s: string): string {
  return s.replace(/<\/?[^>]+(>|$)/g, '')
}

// Fetches the quoted (reply-to) message over the wire and renders it into the
// formatQuotedPrefix block. Returns null on any failure path — wire error,
// errorCode, non-text envelope, or timeout — so the caller delivers the inbound
// without quoted context (silent degradation). A hard timeout (default 5s)
// caps the wait since this sits on the inbound coalescer path.
export async function fetchQuotedContext(
  wsClient: Pick<WsClient, 'sendRequest'>,
  replyMessageId: string,
  resolveAuthorName: (authorId: string) => string,
  logger: { warn(m: string): void } | null,
  timeoutMs = 5000,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    const call = (async (): Promise<string | null> => {
      const resp = await wsClient.sendRequest('getMessageById', { messageId: replyMessageId })
      const payload = resp.payload ?? {}
      const errorCode = payload.errorCode
      if (typeof errorCode === 'number' && errorCode !== 0) return null
      if (payload.type !== EnvelopeType.PLAIN_MESSAGE) return null
      const content = payload.content as { text?: unknown; parseMode?: unknown } | undefined
      if (!content || typeof content.text !== 'string') return null
      const text = content.parseMode === 'html' ? stripTags(content.text) : content.text
      const author = payload.author as { id?: unknown } | undefined
      const authorId = typeof author?.id === 'string' ? author.id : ''
      return formatQuotedPrefix(resolveAuthorName(authorId), text)
    })()
    return await Promise.race([call, timeout])
  } catch (err) {
    logger?.warn(`[trueconf] fetchQuotedContext failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
