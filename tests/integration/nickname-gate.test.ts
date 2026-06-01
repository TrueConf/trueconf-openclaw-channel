import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCoalesceBufferForTesting, handleInboundMessage, type InboundContext } from '../../src/inbound'
import { EnvelopeType, TrueConfChatType, type InboundMessage, type TrueConfRequest } from '../../src/types'

const ACCOUNT = 'default'
const BOT_ID = 'bot@srv'
const ALICE = 'alice@srv'
const GROUP_CHAT = 'group_42'

function makeCtx(opts: { matchesNickname?: (text: string) => boolean } = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const dispatch = vi.fn()
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'getChatByID') return { type: 2, id: 1, payload: { chatType: TrueConfChatType.GROUP } }
    return { type: 2, id: 1, payload: {} }
  })
  const wsClient = { botUserId: BOT_ID, sendRequest, send: vi.fn() }
  const ctx: InboundContext = {
    wsClient: wsClient as never,
    botIdentityCandidates: [BOT_ID],
    accountId: ACCOUNT,
    dispatch,
    logger,
    directChats: new Map(),
    chatTypes: new Map(),
    inflightChatTypes: new Map(),
    recentBotMsgIds: new Map<string, Set<string>>(),
    isAlwaysRespond: () => false,
    matchesNickname: opts.matchesNickname ?? (() => false),
  }
  return { ctx, dispatch }
}

function makeRequest(payload: Record<string, unknown>): TrueConfRequest {
  return { type: 1, id: 100, method: 'sendMessage', payload }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 350))

describe('F1 — global nickname activation in the group gate', () => {
  beforeEach(() => {
    __resetCoalesceBufferForTesting()
    vi.useRealTimers()
  })
  afterEach(() => __resetCoalesceBufferForTesting())

  it('PLAIN in a group containing a nickname (no mention/reply) → dispatched', async () => {
    const h = makeCtx({ matchesNickname: (t) => t.toLowerCase().includes('клешня') })

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.PLAIN_MESSAGE,
        chatId: GROUP_CHAT,
        author: { id: ALICE, type: 1 },
        content: { text: 'Клешня, привет', parseMode: 'text' },
        messageId: 'm-1',
        timestamp: 1,
      }),
      h.ctx,
    )
    await flush()

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const arg = h.dispatch.mock.calls[0][0] as InboundMessage
    expect(arg.text).toBe('Клешня, привет')
  })

  it('PLAIN in a group without a nickname → dropped', async () => {
    const h = makeCtx({ matchesNickname: () => false })

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.PLAIN_MESSAGE,
        chatId: GROUP_CHAT,
        author: { id: ALICE, type: 1 },
        content: { text: 'привет всем', parseMode: 'text' },
        messageId: 'm-2',
        timestamp: 2,
      }),
      h.ctx,
    )
    await flush()

    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('bot’s own message containing a nickname → dropped by self-author guard', async () => {
    const h = makeCtx({ matchesNickname: () => true })

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.PLAIN_MESSAGE,
        chatId: GROUP_CHAT,
        author: { id: BOT_ID, type: 1 },
        content: { text: 'я Клешня', parseMode: 'text' },
        messageId: 'm-3',
        timestamp: 3,
      }),
      h.ctx,
    )
    await flush()

    expect(h.dispatch).not.toHaveBeenCalled()
  })
})
