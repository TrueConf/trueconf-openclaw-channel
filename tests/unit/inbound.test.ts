import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCoalesceBufferForTesting,
  handleInboundMessage,
  type InboundContext,
} from '../../src/inbound'
import { EnvelopeType, TrueConfChatType, type InboundMessage, type TrueConfRequest } from '../../src/types'

interface FakeWsClient {
  botUserId: string | null
  sendRequest: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

interface Harness {
  ctx: InboundContext
  dispatch: ReturnType<typeof vi.fn>
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  wsClient: FakeWsClient
  chatTypes: Map<string, 'p2p' | 'group' | 'channel' | 'unknown'>
  recentBotMsgIds: Map<string, Set<string>>
  alwaysRespondChats: Set<string>
}

const ACCOUNT = 'default'
const BOT_ID = 'bot@srv'
const ALICE = 'alice@srv'
const BOB = 'bob@srv'
const DM_CHAT = 'chat_alice@srv'
const GROUP_CHAT = 'group_42'

function makeHarness(opts?: { chatType?: 'p2p' | 'group' }): Harness {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const dispatch = vi.fn()
  const wsClient: FakeWsClient = {
    botUserId: BOT_ID,
    sendRequest: vi.fn(async (method: string) => {
      if (method === 'getChatByID') {
        const chatType = opts?.chatType === 'group' ? TrueConfChatType.GROUP : TrueConfChatType.P2P
        return { type: 2, id: 1, payload: { chatType } } as never
      }
      return { type: 2, id: 1, payload: {} } as never
    }),
    send: vi.fn(),
  }
  const chatTypes = new Map<string, 'p2p' | 'group' | 'channel' | 'unknown'>()
  const recentBotMsgIds = new Map<string, Set<string>>()
  const alwaysRespondChats = new Set<string>()

  const ctx: InboundContext = {
    wsClient: wsClient as never,
    botIdentityCandidates: [BOT_ID],
    accountId: ACCOUNT,
    dispatch,
    logger,
    directChats: new Map(),
    chatTypes,
    inflightChatTypes: new Map(),
    recentBotMsgIds,
    isAlwaysRespond: (chatId: string) => alwaysRespondChats.has(chatId),
  }
  return { ctx, dispatch, logger, wsClient, chatTypes, recentBotMsgIds, alwaysRespondChats }
}

function makeRequest(payload: Record<string, unknown>): TrueConfRequest {
  return { type: 1, id: 100, method: 'sendMessage', payload }
}

async function flushCoalesce(): Promise<void> {
  // Drive the 300ms coalesce timer.
  await new Promise((r) => setTimeout(r, 350))
}

describe('handleInboundMessage — envelope routing 201/203/204', () => {
  beforeEach(() => {
    __resetCoalesceBufferForTesting()
    vi.useRealTimers()
  })

  afterEach(() => {
    __resetCoalesceBufferForTesting()
  })

  it('FORWARDED (201) → coalescer + extraContext.TrueConfEnvelopeType=forwarded (DM)', async () => {
    const h = makeHarness({ chatType: 'p2p' })
    h.chatTypes.set(DM_CHAT, 'p2p')

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.FORWARDED_MESSAGE,
        chatId: DM_CHAT,
        author: { id: ALICE, type: 1 },
        content: { text: 'hi from forward', parseMode: 'text' },
        messageId: 'm-fwd-1',
        timestamp: 1,
      }),
      h.ctx,
    )
    await flushCoalesce()

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const arg = h.dispatch.mock.calls[0][0] as InboundMessage
    expect(arg.text).toBe('hi from forward')
    expect(arg.extraContext).toBeDefined()
    expect(arg.extraContext!.TrueConfEnvelopeType).toBe('forwarded')
  })

  it('LOCATION (203) valid without description → synthetic text [Локация: lat=…, lng=…] + extraContext.location', async () => {
    const h = makeHarness({ chatType: 'p2p' })
    h.chatTypes.set(DM_CHAT, 'p2p')

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.LOCATION,
        chatId: DM_CHAT,
        author: { id: ALICE, type: 1 },
        content: { latitude: 55.75, longitude: 37.61 },
        messageId: 'm-loc-1',
        timestamp: 2,
      }),
      h.ctx,
    )
    await flushCoalesce()

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const arg = h.dispatch.mock.calls[0][0] as InboundMessage
    expect(arg.text).toBe('[Локация: lat=55.75, lng=37.61]')
    expect(arg.extraContext).toBeDefined()
    expect(arg.extraContext!.TrueConfEnvelopeType).toBe('location')
    const loc = arg.extraContext!.location as { latitude: number; longitude: number; description: string | null }
    expect(loc.latitude).toBe(55.75)
    expect(loc.longitude).toBe(37.61)
    expect(loc.description).toBeNull()
  })

  it('LOCATION (203) valid with description → synthetic text appends description', async () => {
    const h = makeHarness({ chatType: 'p2p' })
    h.chatTypes.set(DM_CHAT, 'p2p')

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.LOCATION,
        chatId: DM_CHAT,
        author: { id: ALICE, type: 1 },
        content: { latitude: 1.5, longitude: 2.5, description: 'Red Square' },
        messageId: 'm-loc-2',
        timestamp: 3,
      }),
      h.ctx,
    )
    await flushCoalesce()

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const arg = h.dispatch.mock.calls[0][0] as InboundMessage
    expect(arg.text).toBe('[Локация: lat=1.5, lng=2.5, описание: Red Square]')
    const loc = arg.extraContext!.location as { description: string | null }
    expect(loc.description).toBe('Red Square')
  })

  it('LOCATION (203) invalid (missing lat/lng) → dropped with logger.warn, no dispatch', async () => {
    const h = makeHarness({ chatType: 'p2p' })
    h.chatTypes.set(DM_CHAT, 'p2p')

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.LOCATION,
        chatId: DM_CHAT,
        author: { id: ALICE, type: 1 },
        content: { description: 'no coords' },
        messageId: 'm-loc-bad',
        timestamp: 4,
      }),
      h.ctx,
    )
    await flushCoalesce()

    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.logger.warn).toHaveBeenCalled()
    const warnArg = h.logger.warn.mock.calls.map((c) => c[0]).join('|')
    expect(warnArg).toContain('LOCATION')
  })

  it('SURVEY (204) valid → synthetic text [Опрос: «title»] + extraContext.survey copy', async () => {
    const h = makeHarness({ chatType: 'p2p' })
    h.chatTypes.set(DM_CHAT, 'p2p')

    const surveyContent = { title: 'Любимый язык?', options: ['ts', 'py'] }
    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.SURVEY,
        chatId: DM_CHAT,
        author: { id: ALICE, type: 1 },
        content: surveyContent,
        messageId: 'm-srv-1',
        timestamp: 5,
      }),
      h.ctx,
    )
    await flushCoalesce()

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const arg = h.dispatch.mock.calls[0][0] as InboundMessage
    expect(arg.text).toBe('[Опрос: «Любимый язык?»]')
    expect(arg.extraContext!.TrueConfEnvelopeType).toBe('survey')
    expect(arg.extraContext!.survey).toEqual(surveyContent)
  })

  it('Group gate for FORWARDED (201): plain forward without mention/reply → dropped', async () => {
    const h = makeHarness({ chatType: 'group' })
    h.chatTypes.set(GROUP_CHAT, 'group')

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.FORWARDED_MESSAGE,
        chatId: GROUP_CHAT,
        author: { id: BOB, type: 1 },
        content: { text: 'forwarded with no mention', parseMode: 'text' },
        messageId: 'm-fwd-grp-1',
        timestamp: 6,
      }),
      h.ctx,
    )
    await flushCoalesce()

    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('Group gate for LOCATION (203) and SURVEY (204): only reply-to-bot activates', async () => {
    const h = makeHarness({ chatType: 'group' })
    h.chatTypes.set(GROUP_CHAT, 'group')
    // bot recently posted msg-bot-1 in this group
    h.recentBotMsgIds.set(GROUP_CHAT, new Set(['msg-bot-1']))

    // LOCATION reply-to-bot → dispatch
    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.LOCATION,
        chatId: GROUP_CHAT,
        author: { id: BOB, type: 1 },
        content: { latitude: 10, longitude: 20 },
        messageId: 'm-loc-grp-1',
        replyMessageId: 'msg-bot-1',
        timestamp: 7,
      }),
      h.ctx,
    )
    await flushCoalesce()
    expect(h.dispatch).toHaveBeenCalledTimes(1)

    h.dispatch.mockClear()

    // SURVEY without reply → dropped
    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.SURVEY,
        chatId: GROUP_CHAT,
        author: { id: BOB, type: 1 },
        content: { title: 'silent survey' },
        messageId: 'm-srv-grp-1',
        timestamp: 8,
      }),
      h.ctx,
    )
    await flushCoalesce()
    expect(h.dispatch).not.toHaveBeenCalled()

    // SURVEY reply-to-bot → dispatch
    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.SURVEY,
        chatId: GROUP_CHAT,
        author: { id: BOB, type: 1 },
        content: { title: 'replied survey' },
        messageId: 'm-srv-grp-2',
        replyMessageId: 'msg-bot-1',
        timestamp: 9,
      }),
      h.ctx,
    )
    await flushCoalesce()
    expect(h.dispatch).toHaveBeenCalledTimes(1)
  })

  it('InboundContext no longer exposes sendAck and handleInboundMessage does not invoke any ack helper', async () => {
    const h = makeHarness({ chatType: 'p2p' })
    h.chatTypes.set(DM_CHAT, 'p2p')

    // The InboundContext type does not have a sendAck field — checked via runtime
    // assertion + tsc (the interface declaration drops the property).
    expect((h.ctx as unknown as { sendAck?: unknown }).sendAck).toBeUndefined()

    await handleInboundMessage(
      makeRequest({
        type: EnvelopeType.PLAIN_MESSAGE,
        chatId: DM_CHAT,
        author: { id: ALICE, type: 1 },
        content: { text: 'hello', parseMode: 'text' },
        messageId: 'm-plain-1',
        timestamp: 10,
      }),
      h.ctx,
    )
    await flushCoalesce()

    // No ws-level send was triggered from inbound (auto-ack is now in WsClient).
    expect(h.wsClient.send).not.toHaveBeenCalled()
  })
})
