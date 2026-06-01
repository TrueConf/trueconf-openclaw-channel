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
