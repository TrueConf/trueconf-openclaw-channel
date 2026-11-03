import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', async () =>
  (await import('./__helpers__/channel-inbound-mock')).channelInboundMock())

import { dispatchChannelInboundTurn, dispatchInboundDirectDm } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'
import type { GroupTurn } from './__helpers__/channel-inbound-mock'

const dmDispatch = vi.mocked(dispatchInboundDirectDm)
const groupDispatch = vi.mocked(dispatchChannelInboundTurn)
const groupTurns = () => groupDispatch.mock.calls.map((call) => call[0] as unknown as GroupTurn)

const OWNER = 'owner@srv'
const ALICE = 'alice@srv'
const BOB = 'bob@srv'

interface Harness {
  abort: () => void
  startPromise: Promise<void>
  info: ReturnType<typeof vi.fn>
}

async function bootPlugin(server: FakeServer, trueconf: Record<string, unknown> = {}): Promise<Harness> {
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
          ...trueconf,
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
  return { abort: () => ac.abort(), startPromise, info: logger.info }
}

function groupText(chatId: string, author: string, messageId: string, mention = true) {
  return {
    type: 200,
    chatId,
    author: { id: author, type: 1 },
    content: mention
      ? { text: '<a href="trueconf:bot@srv">Bot</a> help', parseMode: 'html' }
      : { text: 'just talking', parseMode: 'text' },
    messageId,
    timestamp: Date.now(),
  }
}

// Gives the plugin time to dispatch (coalesce window is 300 ms).
const settle = () => new Promise((r) => setTimeout(r, 450))

// Message id of every group turn dispatched so far.
const dispatchedIds = () => groupTurns().map((turn) => turn.ctxPayload.messageId).sort()

describe('integration: groups and groupPolicy decide which groups this instance serves', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    dmDispatch.mockClear()
    groupDispatch.mockClear()
    server = await startFakeServer()
    server.chats.set([
      { chatId: 'mine', title: 'Моя группа', chatType: 2 },
      { chatId: 'foreign', title: 'Чужая группа', chatType: 2 },
      { chatId: 'paused', title: 'На паузе', chatType: 2 },
    ])
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
  })

  it('serves only listed groups, answers any participant there and logs each ignored chat once', async () => {
    harness = await bootPlugin(server, {
      groups: { mine: { requireMention: true }, paused: { enabled: false } },
    })

    server.pushInbound(groupText('foreign', ALICE, 'f1'))
    server.pushInbound(groupText('foreign', BOB, 'f2'))
    server.pushInbound(groupText('paused', ALICE, 'p1'))
    server.pushInbound(groupText('mine', ALICE, 'm1'))
    await waitFor(() => groupDispatch.mock.calls.length >= 1)
    await settle()

    expect(dispatchedIds()).toEqual(['m1'])
    expect(harness.info.mock.calls.flat().filter((line: string) => line.startsWith('[trueconf] ignoring group'))).toEqual([
      '[trueconf] ignoring group chatId=foreign title="Чужая группа": not listed in channels.trueconf.groups',
      '[trueconf] ignoring group chatId=paused title="На паузе": disabled in channels.trueconf.groups',
    ])
  })

  it('serves every group when groups is not configured', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupText('mine', ALICE, 'm1'))
    server.pushInbound(groupText('foreign', BOB, 'f1'))
    await waitFor(() => groupDispatch.mock.calls.length >= 2)

    expect(dispatchedIds()).toEqual(['f1', 'm1'])
  })

  it('groupPolicy "disabled" serves no group, even a listed one', async () => {
    harness = await bootPlugin(server, { groupPolicy: 'disabled', groups: { mine: {} } })

    server.pushInbound(groupText('mine', ALICE, 'm1'))
    server.pushInbound({ ...groupText('chat_alice@srv', ALICE, 'd1', false) })
    await waitFor(() => dmDispatch.mock.calls.length >= 1)
    await settle()

    expect({ group: dispatchedIds(), dm: dmDispatch.mock.calls.map((call) => call[0].messageId) }).toEqual({
      group: [],
      dm: ['d1'],
    })
  })

  it('groupPolicy "allowlist" admits only listed senders, from groupAllowFrom or the group entry', async () => {
    harness = await bootPlugin(server, {
      groupPolicy: 'allowlist',
      groupAllowFrom: [OWNER],
      groups: { mine: {}, foreign: { allowFrom: [BOB] } },
    })

    server.pushInbound(groupText('mine', ALICE, 'm-alice'))
    server.pushInbound(groupText('mine', OWNER, 'm-owner'))
    server.pushInbound(groupText('foreign', OWNER, 'f-owner'))
    server.pushInbound(groupText('foreign', BOB, 'f-bob'))
    await waitFor(() => groupDispatch.mock.calls.length >= 2)
    await settle()

    expect(dispatchedIds()).toEqual(['f-bob', 'm-owner'])
  })

  it('groupPolicy "allowlist" without groupAllowFrom falls back to allowFrom', async () => {
    harness = await bootPlugin(server, { groupPolicy: 'allowlist', allowFrom: [OWNER] })

    server.pushInbound(groupText('mine', ALICE, 'm-alice'))
    server.pushInbound(groupText('foreign', OWNER, 'f-owner'))
    await waitFor(() => groupDispatch.mock.calls.length >= 1)
    await settle()

    expect(dispatchedIds()).toEqual(['f-owner'])
  })

  it('requireMention: false makes a group always-on, in the gate and in the requireMention adapter', async () => {
    const trueconf = { groups: { mine: { requireMention: false }, '*': { requireMention: true } } }
    harness = await bootPlugin(server, trueconf)

    server.pushInbound(groupText('mine', ALICE, 'm1', false))
    server.pushInbound(groupText('foreign', ALICE, 'f1', false))
    server.pushInbound(groupText('foreign', ALICE, 'f2'))
    await waitFor(() => dispatchedIds().includes('f2'))
    await settle()

    const mentions = groupTurns().map((turn) => [turn.ctxPayload.messageId, turn.ctxPayload.access.mentions])
    expect(mentions.sort()).toEqual([
      ['f2', { canDetectMention: true, wasMentioned: true, requireMention: true }],
      ['m1', { canDetectMention: true, wasMentioned: false, requireMention: false }],
    ])
    const cfg = { channels: { trueconf } } as never
    const resolve = channelPlugin.groups.resolveRequireMention
    // OpenClaw hands the adapter a lowercased group id.
    expect([
      resolve({ cfg, groupId: 'mine', accountId: 'default' }),
      resolve({ cfg, groupId: 'foreign', accountId: 'default' }),
    ]).toEqual([false, true])
  })

  it('drops a DM from a sender outside allowFrom before any file request, and serves the owner', async () => {
    harness = await bootPlugin(server, { dmPolicy: 'allowlist', allowFrom: [OWNER] })
    server.setFile('f-alice', { body: Buffer.from('alice'), mimeType: 'text/plain' })
    server.setFile('f-owner', { body: Buffer.from('owner'), mimeType: 'text/plain' })
    const fileFrom = (author: string, fileId: string) => ({
      type: 202,
      chatId: `chat_${author}`,
      author: { id: author, type: 1 },
      content: { fileId, name: `${fileId}.txt`, size: 5, mimeType: 'text/plain', readyState: 2 },
      messageId: `msg-${fileId}`,
      timestamp: Date.now(),
    })

    server.pushInbound(fileFrom(ALICE, 'f-alice'))
    server.pushInbound(fileFrom(OWNER, 'f-owner'))
    await waitFor(() => dmDispatch.mock.calls.length >= 1, 5000)
    await settle()

    expect({
      fileInfo: server.getFileInfoRequests.map((r) => r.payload.fileId),
      dispatched: dmDispatch.mock.calls.map((call) => call[0].senderId),
      replies: server.messageRequests.length,
    }).toEqual({ fileInfo: ['f-owner'], dispatched: [OWNER], replies: 0 })
  })
})
