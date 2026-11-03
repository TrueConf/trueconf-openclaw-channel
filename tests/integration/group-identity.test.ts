import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', async () =>
  (await import('./__helpers__/channel-inbound-mock')).channelInboundMock())

import { dispatchChannelInboundTurn } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'
import type { GroupTurn } from './__helpers__/channel-inbound-mock'

const groupDispatch = vi.mocked(dispatchChannelInboundTurn)
const groupTurns = () => groupDispatch.mock.calls.map((call) => call[0] as unknown as GroupTurn)

const ALICE = 'alice@srv'

interface Harness {
  abort: () => void
  startPromise: Promise<void>
}

async function bootPlugin(server: FakeServer): Promise<Harness> {
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

function mention(chatId: string, messageId: string, author = ALICE) {
  return {
    type: 200,
    chatId,
    author: { id: author, type: 1 },
    content: { text: '<a href="trueconf:bot@srv">Bot</a> hi', parseMode: 'html' },
    messageId,
    timestamp: Date.now(),
  }
}

describe('integration: group title and sender names', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    groupDispatch.mockClear()
    server = await startFakeServer()
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
  })

  it('labels a group turn with the chat title, falls back to Group <chatId> and follows a rename', async () => {
    server.chats.add({ chatId: 'titled', title: 'Отдел продаж', chatType: 2 })
    server.chats.add({ chatId: 'untitled', title: '', chatType: 2 })
    harness = await bootPlugin(server)

    server.pushInbound(mention('titled', 'g1'))
    server.pushInbound(mention('untitled', 'g2'))
    await waitFor(() => groupDispatch.mock.calls.length >= 2)
    server.pushEvent('editChatTitle', { chatId: 'titled', title: 'Продажи' })
    server.pushInbound(mention('titled', 'g3'))
    await waitFor(() => groupDispatch.mock.calls.length >= 3)

    const labels = Object.fromEntries(
      groupTurns().map((turn) => [turn.ctxPayload.messageId, turn.ctxPayload.conversation.label]),
    )
    expect(labels).toEqual({ g1: 'Отдел продаж', g2: 'Group untitled', g3: 'Продажи' })
  })

  it('names the sender from getUserDisplayName and falls back to the userId on an error or a 3 s timeout', { timeout: 15_000 }, async () => {
    server.chats.add({ chatId: 'team', title: 'Team', chatType: 2 })
    server.setDisplayName(ALICE, 'Александр Пономарёв')
    server.setDisplayName('bob@srv', { errorCode: 304 })
    server.setDisplayName('carol@srv', 'hang')
    harness = await bootPlugin(server)

    server.pushInbound(mention('team', 'n1', ALICE))
    server.pushInbound(mention('team', 'n2', 'bob@srv'))
    server.pushInbound(mention('team', 'n3', 'carol@srv'))
    await waitFor(() => groupDispatch.mock.calls.length >= 3, 8000)

    const seen = Object.fromEntries(
      groupTurns().map(({ ctxPayload }) => [
        ctxPayload.messageId,
        { sender: ctxPayload.sender, body: ctxPayload.message.body, bodyForAgent: ctxPayload.message.bodyForAgent },
      ]),
    )
    expect(seen).toEqual({
      n1: {
        sender: { id: ALICE, name: 'Александр Пономарёв' },
        body: '[TrueConf Team] Александр Пономарёв (alice@srv): Bot hi',
        bodyForAgent: 'Александр Пономарёв (alice@srv): Bot hi',
      },
      n2: {
        sender: { id: 'bob@srv', name: 'bob@srv' },
        body: '[TrueConf Team] bob@srv: Bot hi',
        bodyForAgent: 'bob@srv: Bot hi',
      },
      n3: {
        sender: { id: 'carol@srv', name: 'carol@srv' },
        body: '[TrueConf Team] carol@srv: Bot hi',
        bodyForAgent: 'carol@srv: Bot hi',
      },
    })
  })
})
