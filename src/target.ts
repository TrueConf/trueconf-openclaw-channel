// A TrueConf outbound destination. A group target names the chat itself; a
// direct target names a user, whose P2P chat is looked up or created on send.
export type TrueConfTarget =
  | { kind: 'group'; chatId: string }
  | { kind: 'direct'; userId: string }

// Group turns tell OpenClaw this as From, To and OriginatingTo, so core reads
// the group id from it and routes message-tool sends, queued follow-ups and
// restart notices back to the chat.
export function groupAddress(chatId: string): string {
  return `trueconf:group:${chatId}`
}

const PROVIDER_PREFIX = /^trueconf:/i
const GROUP_PREFIX = /^group:/i

// Accepts `trueconf:group:<id>`, `group:<id>`, `trueconf:<jid>` and `<jid>`,
// with an optional per-connection `/resource` on a JID. Returns null when no
// usable id is left.
export function parseTarget(raw: string): TrueConfTarget | null {
  const unprefixed = raw.trim().replace(PROVIDER_PREFIX, '').trim()
  if (GROUP_PREFIX.test(unprefixed)) {
    const chatId = unprefixed.replace(GROUP_PREFIX, '').trim()
    return isUsableId(chatId) ? { kind: 'group', chatId } : null
  }
  const userId = unprefixed.replace(/\/.*$/, '').trim()
  return isUsableId(userId) ? { kind: 'direct', userId } : null
}

export function formatTarget(target: TrueConfTarget): string {
  return target.kind === 'group' ? `group:${target.chatId}` : target.userId
}

function isUsableId(id: string): boolean {
  return id.length > 0 && !id.includes('\u0000')
}
