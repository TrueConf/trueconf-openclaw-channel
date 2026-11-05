import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrueConfFlatConfig } from '../../src/types'

vi.mock('openclaw/plugin-sdk/channel-inbound', async () =>
  (await import('./__helpers__/channel-inbound-mock')).channelInboundMock())

import { dispatchChannelInboundTurn, dispatchInboundDirectDm } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'
import type { GroupTurn } from './__helpers__/channel-inbound-mock'

const dmDispatch = vi.mocked(dispatchInboundDirectDm)
const groupDispatch = vi.mocked(dispatchChannelInboundTurn)
const groupTurn = (i: number) => groupDispatch.mock.calls[i][0] as unknown as GroupTurn
const dispatchCount = () => dmDispatch.mock.calls.length + groupDispatch.mock.calls.length

interface Harness {
  abort: () => void
  startPromise: Promise<void>
}

async function bootPlugin(
  server: FakeServer,
  extraConfig: Partial<TrueConfFlatConfig> = {},
): Promise<Harness> {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const api = {
    logger,
    runtime: {},
    config: {
      channels: {
        trueconf: {
          serverUrl: server.serverUrl,
          port: server.port,
          useTls: false,
          username: 'bot@srv',
          password: 'secret',
          ...extraConfig,
        },
      },
    },
    on: () => {},
    registerTool: () => {},
  }
  registerFull(api as never)
  const ac = new AbortController()
  const startPromise = (channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>)({
    accountId: 'default',
    setStatus: () => {},
    abortSignal: ac.signal,
  })
  await waitFor(() => server.authRequests.length >= 1 && server.connections.size > 0)
  return { abort: () => ac.abort(), startPromise }
}

const GROUP_CHAT = 'group_123'
const ALICE = 'alice@srv'
const BOB = 'bob@srv'

function groupTextEnvelope(opts: {
  author: string
  text: string
  parseMode: 'text' | 'markdown' | 'html'
  messageId: string
  replyMessageId?: string
  chatId?: string
}) {
  return {
    type: 200,
    chatId: opts.chatId ?? GROUP_CHAT,
    author: { id: opts.author, type: 1 },
    content: { text: opts.text, parseMode: opts.parseMode },
    messageId: opts.messageId,
    timestamp: Date.now(),
    ...(opts.replyMessageId ? { replyMessageId: opts.replyMessageId } : {}),
  }
}

describe('integration: group chat mention/reply gate', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    dmDispatch.mockClear()
    groupDispatch.mockClear()
    server = await startFakeServer()
    server.chats.add({ chatId: GROUP_CHAT, title: 'Team chat', chatType: 2 })
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
  })

  it('html message mentioning bot → group turn for the chat, sender=author', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: '<a href="trueconf:bot@srv">Bot</a> what is up',
      parseMode: 'html',
      messageId: 'g1',
    }))

    await waitFor(() => groupDispatch.mock.calls.length >= 1, 3000)
    await new Promise((r) => setTimeout(r, 350))

    expect(groupDispatch.mock.calls).toHaveLength(1)
    expect(dmDispatch).not.toHaveBeenCalled()
    const turn = groupTurn(0)
    expect(turn.route.sessionKey).toBe(`agent:main:trueconf:group:${GROUP_CHAT}`)
    expect(turn.ctxPayload).toMatchObject({
      from: 'trueconf:group:group_123',
      sender: { id: ALICE },
      conversation: { kind: 'group', id: GROUP_CHAT, label: 'Team chat' },
      reply: { to: 'trueconf:group:group_123', originatingTo: 'trueconf:group:group_123' },
      message: {
        body: '[TrueConf Team chat] alice@srv: Bot what is up',
        bodyForAgent: 'alice@srv: Bot what is up',
        rawBody: 'Bot what is up',
        commandBody: 'Bot what is up',
      },
      access: { commands: { authorized: false }, mentions: { wasMentioned: true, requireMention: true } },
    })
  })

  it('html mention with real-server query suffix (&do=profile) → dispatch', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: '<a href="trueconf:bot@srv&do=profile">bot</a> hey',
      parseMode: 'html',
      messageId: 'g1b',
    }))

    await waitFor(() => groupDispatch.mock.calls.length >= 1, 3000)
    const { ctxPayload } = groupTurn(0)
    expect(ctxPayload.sender.id).toBe(ALICE)
    expect(ctxPayload.message.rawBody).toBe('bot hey')
  })

  it('html mention with bot identity carrying an instance suffix (/xyz) → dispatch', async () => {
    const serverWithInstance = await startFakeServer({ botUserId: 'bot@srv/abc123' })
    try {
      serverWithInstance.setChatType(GROUP_CHAT, 2)
      const innerHarness = await (async () => {
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
        const api = {
          logger,
          runtime: {},
          config: {
            channels: {
              trueconf: {
                serverUrl: serverWithInstance.serverUrl,
                port: serverWithInstance.port,
                useTls: false,
                username: 'bot@srv',
                password: 'secret',
              },
            },
          },
          on: () => {},
          registerTool: () => {},
        }
        registerFull(api as never)
        const ac = new AbortController()
        const startPromise = (channelPlugin.gateway.startAccount as (c: Record<string, unknown>) => Promise<void>)({
          accountId: 'default',
          setStatus: () => {},
          abortSignal: ac.signal,
        })
        await waitFor(() => serverWithInstance.authRequests.length >= 1 && serverWithInstance.connections.size > 0)
        return { abort: () => ac.abort(), startPromise }
      })()

      serverWithInstance.pushInbound(groupTextEnvelope({
        author: ALICE,
        text: '<a href="trueconf:bot@srv&do=profile">bot</a> ping',
        parseMode: 'html',
        messageId: 'g1c',
      }))

      await waitFor(() => groupDispatch.mock.calls.length >= 1, 3000)
      expect(groupTurn(0).ctxPayload).toMatchObject({
        message: { rawBody: 'bot ping' },
        access: { mentions: { wasMentioned: true, requireMention: true } },
      })
      innerHarness.abort()
      await Promise.race([innerHarness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
    } finally {
      await serverWithInstance.close()
    }
  })

  it('html message mentioning a different user (not bot) → drop', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: '<a href="trueconf:bob@srv">Bob</a> please review',
      parseMode: 'html',
      messageId: 'g2',
    }))

    await new Promise((r) => setTimeout(r, 400))
    expect(dispatchCount()).toBe(0)
  })

  it('plain-text message without mention → drop', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: 'just chatting in the group',
      parseMode: 'text',
      messageId: 'g3',
    }))

    await new Promise((r) => setTimeout(r, 400))
    expect(dispatchCount()).toBe(0)
  })

  it('reply to a recent bot message → dispatch fires', { retry: 3 }, async () => {
    harness = await bootPlugin(server)

    // First: an activating message so the bot replies into the group, recording its messageId
    groupDispatch.mockImplementationOnce(async (plan) => {
      await (plan as unknown as GroupTurn).delivery.deliver({ text: 'first reply' })
      return {} as never
    })
    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: '<a href="trueconf:bot@srv">Bot</a> hi',
      parseMode: 'html',
      messageId: 'g4',
    }))
    await waitFor(() => server.messageRequests.length >= 1, 3000)
    const botMsgId = `msg_${server.messageRequests[0].id}`

    groupDispatch.mockClear()

    // Second: plain text reply targeting the bot's previous messageId
    server.pushInbound(groupTextEnvelope({
      author: BOB,
      text: 'replying without mention',
      parseMode: 'text',
      messageId: 'g5',
      replyMessageId: botMsgId,
    }))

    // Flaky only on CI (Linux): the bot's first reply is recorded in the
    // recent-bot-message buffer just after its send ack, so under CI scheduling
    // the follow-up reply can be processed before the buffer records the id —
    // the gate misses, the dispatch never fires, and waitFor times out. Passes
    // locally every time. Guarded by it(..., { retry: 3 }) above; the 6s budget
    // is ample on the happy path.
    await waitFor(() => groupDispatch.mock.calls.length >= 1, 6000)
    expect(groupTurn(0).ctxPayload).toMatchObject({
      sender: { id: BOB },
      message: { rawBody: 'replying without mention' },
      access: { mentions: { wasMentioned: true, requireMention: true } },
    })
  })

  it('reply to an unknown messageId → drop', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: 'replying to nothing',
      parseMode: 'text',
      messageId: 'g6',
      replyMessageId: 'msg_does_not_exist',
    }))

    await new Promise((r) => setTimeout(r, 400))
    expect(dispatchCount()).toBe(0)
  })

  it('deliver in group sends to the group chatId, not to a P2P chat', async () => {
    harness = await bootPlugin(server)

    groupDispatch.mockImplementationOnce(async (plan) => {
      await (plan as unknown as GroupTurn).delivery.deliver({ text: 'hello group' })
      return {} as never
    })

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: '<a href="trueconf:bot@srv">Bot</a> ping',
      parseMode: 'html',
      messageId: 'g7',
    }))

    await waitFor(() => server.messageRequests.length >= 1, 3000)
    const sent = server.messageRequests[0].payload as { chatId: string; content: { text: string } }
    expect(sent.chatId).toBe(GROUP_CHAT)
    expect(sent.content.text).toBe('hello group')
  })

  it('unrecognized chatType (e.g. 99) → drop, never downgrade to direct', async () => {
    harness = await bootPlugin(server)
    server.setChatType('weird_chat', 99)

    server.pushInbound({
      type: 200,
      chatId: 'weird_chat',
      author: { id: ALICE, type: 1 },
      content: { text: 'anything', parseMode: 'text' },
      messageId: 'w1',
      timestamp: Date.now(),
    })

    await new Promise((r) => setTimeout(r, 400))
    expect(dispatchCount()).toBe(0)
    // Critical: no error reply, no fallback createP2PChat-then-sendMessage —
    // the message is silently dropped so the next inbound retries the lookup.
    expect(server.messageRequests).toHaveLength(0)
  })

  it('group attachment failure → error reply targets group chatId, NOT a P2P chat', async () => {
    harness = await bootPlugin(server)
    server.setFileInfoSequence('file-gone', [{ readyState: 0 }])

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: '<a href="trueconf:bot@srv">Bot</a> here',
      parseMode: 'html',
      messageId: 'g-att-text',
    }))
    server.pushInbound({
      type: 202,
      chatId: GROUP_CHAT,
      author: { id: ALICE, type: 1 },
      content: { fileId: 'file-gone', name: 'gone.png', size: 10, mimeType: 'image/png', readyState: 1 },
      messageId: 'g-att-file',
      timestamp: Date.now(),
    })

    await waitFor(() => server.messageRequests.length >= 1, 4000)
    // The error reply must land in the group chat directly. Before the fix,
    // this would have routed through createP2PChat({userId: GROUP_CHAT}) →
    // sendMessage({chatId: `chat_${GROUP_CHAT}`}), missing the actual group.
    const errorReply = server.messageRequests[0].payload as { chatId: string; content: { text: string } }
    expect(errorReply.chatId).toBe(GROUP_CHAT)
    expect(errorReply.content.text.length).toBeGreaterThan(0)
  })

  it('direct (P2P) chats still dispatch every message without a gate', async () => {
    harness = await bootPlugin(server)

    server.pushInbound({
      type: 200,
      chatId: 'chat_alice@srv',
      author: { id: ALICE, type: 1 },
      content: { text: 'no mention needed', parseMode: 'text' },
      messageId: 'd1',
      timestamp: Date.now(),
    })

    await waitFor(() => dmDispatch.mock.calls.length >= 1, 3000)
    const arg = dmDispatch.mock.calls[0][0]
    expect(arg.peer.kind).toBe('direct')
    expect(arg.peer.id).toBe(ALICE)
    expect(arg.senderId).toBe(ALICE)
    expect(groupDispatch).not.toHaveBeenCalled()
  })

  it('bypasses mention gate when chatId is listed in groupAlwaysRespondIn', async () => {
    const ALWAYS_CHAT = 'chat_group_abc'
    server.setChatType(ALWAYS_CHAT, 2)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['chatId:chat_group_abc'] })

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: 'no mention here',
      parseMode: 'text',
      messageId: 'gar1',
      chatId: ALWAYS_CHAT,
    }))

    await waitFor(() => groupDispatch.mock.calls.length >= 1, 3000)
    expect(groupDispatch).toHaveBeenCalledTimes(1)
    expect(groupTurn(0).ctxPayload).toMatchObject({
      conversation: { id: ALWAYS_CHAT },
      access: { mentions: { wasMentioned: false, requireMention: false } },
    })
  })

  it('groups.resolveRequireMention is false for an always-respond chat and true for others', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['chatId:Chat_Group_ABC'] })
    const resolve = channelPlugin.groups.resolveRequireMention
    const cfg = {} as never

    // OpenClaw lowercases the group id it reads from From.
    expect(resolve({ cfg, groupId: 'chat_group_abc', accountId: 'default' })).toBe(false)
    expect(resolve({ cfg, groupId: GROUP_CHAT, accountId: 'default' })).toBe(true)
  })

  it('keeps existing gate when chatId is absent from groupAlwaysRespondIn', async () => {
    const OTHER_CHAT = 'chat_group_xyz'
    server.setChatType(OTHER_CHAT, 2)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['chatId:not_this_one'] })

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: 'no mention here',
      parseMode: 'text',
      messageId: 'gar2',
      chatId: OTHER_CHAT,
    }))

    // Give it time to *not* dispatch
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatchCount()).toBe(0)
  })
})
