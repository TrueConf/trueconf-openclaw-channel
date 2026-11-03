import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCoalesceBufferForTesting,
  getMaxFileSize,
  handleInboundMessage,
  MAX_FILE_SIZE_HARD_LIMIT_BYTES,
  type InboundContext,
} from '../../src/inbound'
import { EnvelopeType, TrueConfChatType, type ChatInfo, type InboundMessage, type TrueConfRequest } from '../../src/types'

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
  chats: Map<string, ChatInfo>
  recentBotMsgIds: Map<string, Set<string>>
  alwaysRespondChats: Set<string>
}

const ACCOUNT = 'default'
const BOT_ID = 'bot@srv'
const ALICE = 'alice@srv'
const BOB = 'bob@srv'
const DM_CHAT = 'chat_alice@srv'
const GROUP_CHAT = 'group_42'

function makeHarness(opts?: { chatType?: 'p2p' | 'group'; matchesNickname?: (text: string) => boolean }): Harness {
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
  const chats = new Map<string, ChatInfo>()
  const recentBotMsgIds = new Map<string, Set<string>>()
  const alwaysRespondChats = new Set<string>()

  const ctx: InboundContext = {
    wsClient: wsClient as never,
    botIdentityCandidates: [BOT_ID],
    accountId: ACCOUNT,
    dispatch,
    logger,
    directChats: new Map(),
    chats,
    inflightChats: new Map(),
    recentBotMsgIds,
    isAlwaysRespond: (chatId: string) => alwaysRespondChats.has(chatId),
    matchesNickname: opts?.matchesNickname ?? (() => false),
  }
  return { ctx, dispatch, logger, wsClient, chats, recentBotMsgIds, alwaysRespondChats }
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
    h.chats.set(DM_CHAT, { kind: 'p2p', title: '' })

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
    h.chats.set(DM_CHAT, { kind: 'p2p', title: '' })

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
    h.chats.set(DM_CHAT, { kind: 'p2p', title: '' })

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
    h.chats.set(DM_CHAT, { kind: 'p2p', title: '' })

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
    h.chats.set(DM_CHAT, { kind: 'p2p', title: '' })

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
    h.chats.set(GROUP_CHAT, { kind: 'group', title: '' })

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
    h.chats.set(GROUP_CHAT, { kind: 'group', title: '' })
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
    h.chats.set(DM_CHAT, { kind: 'p2p', title: '' })

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

describe('handleInboundMessage — group wasMentioned', () => {
  beforeEach(() => __resetCoalesceBufferForTesting())
  afterEach(() => __resetCoalesceBufferForTesting())

  const mentionText = (messageId: string, text: string) => makeRequest({
    type: EnvelopeType.PLAIN_MESSAGE,
    chatId: GROUP_CHAT,
    author: { id: ALICE, type: 1 },
    content: { text, parseMode: 'html' },
    messageId,
    timestamp: 1,
  })
  const attachment = (messageId: string) => makeRequest({
    type: EnvelopeType.ATTACHMENT,
    chatId: GROUP_CHAT,
    author: { id: ALICE, type: 1 },
    content: { fileId: 'f-1', name: 'plan.pdf', size: 10, mimeType: 'application/pdf', readyState: 2 },
    messageId,
    timestamp: 2,
  })

  it('an attachment coalesced with a mentioning caption carries wasMentioned true', async () => {
    const h = makeHarness({ chatType: 'group' })

    await handleInboundMessage(mentionText('m-cap', '<a href="trueconf:bot@srv">Bot</a> see file'), h.ctx)
    await handleInboundMessage(attachment('m-file'), h.ctx)
    await flushCoalesce()

    expect(h.dispatch.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ messageId: 'm-file', text: 'Bot see file', isGroup: true, wasMentioned: true }),
    ])
  })

  it('in an always-respond chat an unaddressed caption and its attachment carry wasMentioned false', async () => {
    const h = makeHarness({ chatType: 'group' })
    h.alwaysRespondChats.add(GROUP_CHAT)

    await handleInboundMessage(mentionText('m-cap', 'see file'), h.ctx)
    await handleInboundMessage(attachment('m-file'), h.ctx)
    await flushCoalesce()

    expect(h.dispatch.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ messageId: 'm-file', text: 'see file', isGroup: true, wasMentioned: false }),
    ])
  })

  it('in an always-respond chat an @-mention still reports wasMentioned true', async () => {
    const h = makeHarness({ chatType: 'group' })
    h.alwaysRespondChats.add(GROUP_CHAT)

    await handleInboundMessage(mentionText('m-1', '<a href="trueconf:bot@srv">Bot</a> hi'), h.ctx)
    await flushCoalesce()

    expect(h.dispatch.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ messageId: 'm-1', isGroup: true, wasMentioned: true }),
    ])
  })
})

describe('getMaxFileSize — bounds', () => {
  const DEFAULT_50MB = 50 * 1024 * 1024

  it('accepts a value within the 2 GiB hard limit', () => {
    expect(getMaxFileSize({ maxFileSize: 100 * 1024 * 1024 } as never)).toBe(100 * 1024 * 1024)
  })

  it('accepts the hard limit boundary exactly', () => {
    expect(getMaxFileSize({ maxFileSize: MAX_FILE_SIZE_HARD_LIMIT_BYTES } as never)).toBe(
      MAX_FILE_SIZE_HARD_LIMIT_BYTES,
    )
  })

  it('falls back to default when value exceeds 2 GiB', () => {
    // The reviewer's concrete case: maxFileSize: 1_000_000_000_000 (≈ 1 TB) used to slip through.
    expect(getMaxFileSize({ maxFileSize: 1_000_000_000_000 } as never)).toBe(DEFAULT_50MB)
    expect(getMaxFileSize({ maxFileSize: MAX_FILE_SIZE_HARD_LIMIT_BYTES + 1 } as never)).toBe(DEFAULT_50MB)
  })

  it('falls back to default for non-positive, non-finite, or non-number values', () => {
    expect(getMaxFileSize({ maxFileSize: 0 } as never)).toBe(DEFAULT_50MB)
    expect(getMaxFileSize({ maxFileSize: -5 } as never)).toBe(DEFAULT_50MB)
    expect(getMaxFileSize({ maxFileSize: Number.POSITIVE_INFINITY } as never)).toBe(DEFAULT_50MB)
    expect(getMaxFileSize({ maxFileSize: Number.NaN } as never)).toBe(DEFAULT_50MB)
    expect(getMaxFileSize({ maxFileSize: '500' } as never)).toBe(DEFAULT_50MB)
    expect(getMaxFileSize({} as never)).toBe(DEFAULT_50MB)
  })
})
