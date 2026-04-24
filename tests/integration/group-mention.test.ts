import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

const dispatch = vi.mocked(dispatchInboundDirectDmWithRuntime)

interface Harness {
  abort: () => void
  startPromise: Promise<void>
}

async function bootPlugin(server: FakeServer): Promise<Harness> {
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
        },
      },
    },
    on: () => {},
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
}) {
  return {
    type: 200,
    chatId: GROUP_CHAT,
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
    dispatch.mockClear()
    server = await startFakeServer()
    server.setChatType(GROUP_CHAT, 2)
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
  })

  it('html message mentioning bot → dispatch with peerId=chatId, senderId=author', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: '<a href="trueconf:bot@srv">Bot</a> what is up',
      parseMode: 'html',
      messageId: 'g1',
    }))

    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    await new Promise((r) => setTimeout(r, 350))

    expect(dispatch.mock.calls).toHaveLength(1)
    const arg = dispatch.mock.calls[0][0] as {
      senderId: string
      rawBody: string
      peer: { kind: string; id: string }
      conversationLabel: string
    }
    expect(arg.senderId).toBe(ALICE)
    expect(arg.peer.id).toBe(GROUP_CHAT)
    expect(arg.conversationLabel).toContain(GROUP_CHAT)
    expect(arg.rawBody).toBe('Bot what is up')
  })

  it('html mention with real-server query suffix (&do=profile) → dispatch', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupTextEnvelope({
      author: ALICE,
      text: '<a href="trueconf:bot@srv&do=profile">bot</a> hey',
      parseMode: 'html',
      messageId: 'g1b',
    }))

    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    const arg = dispatch.mock.calls[0][0] as { rawBody: string; senderId: string }
    expect(arg.senderId).toBe(ALICE)
    expect(arg.rawBody).toBe('bot hey')
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

      await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
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
    expect(dispatch).not.toHaveBeenCalled()
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
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reply to a recent bot message → dispatch fires', async () => {
    harness = await bootPlugin(server)

    // First: an activating message so the bot replies into the group, recording its messageId
    dispatch.mockImplementationOnce(async (arg: { deliver?: (payload: { text: string }) => Promise<void> }) => {
      if (arg.deliver) await arg.deliver({ text: 'first reply' })
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

    dispatch.mockClear()

    // Second: plain text reply targeting the bot's previous messageId
    server.pushInbound(groupTextEnvelope({
      author: BOB,
      text: 'replying without mention',
      parseMode: 'text',
      messageId: 'g5',
      replyMessageId: botMsgId,
    }))

    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    const arg = dispatch.mock.calls[0][0] as { senderId: string; rawBody: string }
    expect(arg.senderId).toBe(BOB)
    expect(arg.rawBody).toBe('replying without mention')
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
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('deliver in group sends to the group chatId, not to a P2P chat', async () => {
    harness = await bootPlugin(server)

    dispatch.mockImplementationOnce(async (arg: { deliver?: (payload: { text: string }) => Promise<void> }) => {
      if (arg.deliver) await arg.deliver({ text: 'hello group' })
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
    expect(dispatch).not.toHaveBeenCalled()
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

    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    const arg = dispatch.mock.calls[0][0] as {
      peer: { kind: string; id: string }
      senderId: string
    }
    expect(arg.peer.kind).toBe('direct')
    expect(arg.peer.id).toBe(ALICE)
    expect(arg.senderId).toBe(ALICE)
  })
})
