import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCoalesceBufferForTesting, handleInboundMessage, type InboundContext } from '../../src/inbound'
import { EnvelopeType, TrueConfChatType, type InboundMessage, type TrueConfRequest } from '../../src/types'

const ACCOUNT = 'default'
const BOT_ID = 'bot@srv'
const ALICE = 'alice@srv'
const BOB = 'bob@srv'
const GROUP_CHAT = 'group_42'
const DM_CHAT = 'chat_bob@srv'

type CtxOpts = {
  chatType?: 'p2p' | 'group'
  getMessageById?: () => Promise<unknown>
  recentBotMsgIds?: Map<string, Set<string>>
}

function makeCtx(opts: CtxOpts = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const dispatch = vi.fn()
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'getChatByID') {
      const chatType = opts.chatType === 'group' ? TrueConfChatType.GROUP : TrueConfChatType.P2P
      return { type: 2, id: 1, payload: { chatType } }
    }
    if (method === 'getMessageById' && opts.getMessageById) return opts.getMessageById()
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
    recentBotMsgIds: opts.recentBotMsgIds ?? new Map<string, Set<string>>(),
    isAlwaysRespond: () => false,
    matchesNickname: () => false,
  }
  return { ctx, dispatch, sendRequest, logger }
}

function makeRequest(payload: Record<string, unknown>): TrueConfRequest {
  return { type: 1, id: 100, method: 'sendMessage', payload }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 350))

describe('F2 — quoted-message context injection', () => {
  beforeEach(() => {
    __resetCoalesceBufferForTesting()
    vi.useRealTimers()
  })
  afterEach(() => __resetCoalesceBufferForTesting())

  it('reply to another user → dispatch text starts with the quoted block', async () => {
    const h = makeCtx({
      chatType: 'p2p',
      getMessageById: async () => ({
        type: 2,
        id: 1,
        payload: { type: 200, author: { id: ALICE }, content: { text: 'Старое сообщение', parseMode: 'text' } },
      }),
    })

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.PLAIN_MESSAGE,
        chatId: DM_CHAT,
        author: { id: BOB, type: 1 },
        content: { text: 'добавь это', parseMode: 'text' },
        messageId: 'm-1',
        timestamp: 1,
        replyMessageId: 'q-1',
      }),
      h.ctx,
    )
    await flush()

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const arg = h.dispatch.mock.calls[0][0] as InboundMessage
    expect(arg.text).toBe('[В ответ на сообщение от alice@srv: «Старое сообщение»]\n\nдобавь это')
  })

  it('reply to the bot’s own message → getMessageById is NOT called, no prefix', async () => {
    const recent = new Map<string, Set<string>>([[GROUP_CHAT, new Set(['botmsg-1'])]])
    const h = makeCtx({ chatType: 'group', recentBotMsgIds: recent })

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.PLAIN_MESSAGE,
        chatId: GROUP_CHAT,
        author: { id: BOB, type: 1 },
        content: { text: 'спасибо', parseMode: 'text' },
        messageId: 'm-2',
        timestamp: 2,
        replyMessageId: 'botmsg-1',
      }),
      h.ctx,
    )
    await flush()

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const arg = h.dispatch.mock.calls[0][0] as InboundMessage
    expect(arg.text).toBe('спасибо')
    expect(h.sendRequest.mock.calls.some((c) => c[0] === 'getMessageById')).toBe(false)
  })

  it('getMessageById throws → message delivered without prefix', async () => {
    const h = makeCtx({
      chatType: 'p2p',
      getMessageById: async () => {
        throw new Error('wire down')
      },
    })

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.PLAIN_MESSAGE,
        chatId: DM_CHAT,
        author: { id: BOB, type: 1 },
        content: { text: 'добавь это', parseMode: 'text' },
        messageId: 'm-3',
        timestamp: 3,
        replyMessageId: 'q-1',
      }),
      h.ctx,
    )
    await flush()

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const arg = h.dispatch.mock.calls[0][0] as InboundMessage
    expect(arg.text).toBe('добавь это')
  })
})
