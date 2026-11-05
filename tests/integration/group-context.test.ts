import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', async () =>
  (await import('./__helpers__/channel-inbound-mock')).channelInboundMock())

import { dispatchChannelInboundTurn } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'
import { recordedTurn, type GroupTurn } from './__helpers__/channel-inbound-mock'

const groupDispatch = vi.mocked(dispatchChannelInboundTurn)
const turnCount = () => groupDispatch.mock.calls.length
const agentBodies = () => groupDispatch.mock.calls.map((call) => (call[0] as unknown as GroupTurn).ctxPayload.message.bodyForAgent)

const ALICE = 'alice@srv'
const BOB = 'bob@srv'
const CAROL = 'carol@srv'
const CONTEXT = '[Chat messages since your last reply - for context]'
const CURRENT = '[Current message - respond to this]'

interface Harness {
  abort: () => void
  startPromise: Promise<void>
  reconfigure: (trueconf: Record<string, unknown>) => void
}

async function bootPlugin(
  server: FakeServer,
  trueconf: Record<string, unknown> = {},
  rest: Record<string, unknown> = {},
): Promise<Harness> {
  const apiFor = (extra: Record<string, unknown>) => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {},
    config: {
      ...rest,
      channels: {
        trueconf: {
          serverUrl: server.serverUrl,
          port: server.port,
          useTls: false,
          username: 'bot@srv',
          password: 'secret',
          ...extra,
        },
      },
    },
    on: () => {},
    registerTool: () => {},
  })
  registerFull(apiFor(trueconf) as never)
  const ac = new AbortController()
  const startPromise = (channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>)({
    accountId: 'default',
    setStatus: () => {},
    abortSignal: ac.signal,
  })
  await waitFor(() => server.authRequests.length >= 1 && server.connections.size > 0)
  // A config reload: the account keeps running, the plugin reads the new config.
  const reconfigure = (next: Record<string, unknown>) => registerFull(apiFor(next) as never)
  return { abort: () => ac.abort(), startPromise, reconfigure }
}

let nextId = 0
function say(author: string, text: string, chatId = 'team') {
  return {
    type: 200,
    chatId,
    author: { id: author, type: 1 },
    content: { text, parseMode: 'text' },
    messageId: `m${++nextId}`,
    timestamp: Date.now(),
  }
}
function ask(author: string, text: string, chatId = 'team') {
  return {
    ...say(author, '', chatId),
    content: { text: `<a href="trueconf:bot@srv">Bot</a> ${text}`, parseMode: 'html' },
  }
}

// Lets the plugin record and dispatch what was pushed (coalesce window 300 ms).
const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms))

describe('integration: unaddressed group lines become context for the next addressed turn', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    groupDispatch.mockReset()
    groupDispatch.mockImplementation(recordedTurn as never)
    server = await startFakeServer()
    server.chats.set([
      { chatId: 'team', title: 'Team', chatType: 2 },
      { chatId: 'foreign', title: 'Foreign', chatType: 2 },
    ])
    server.setDisplayName(ALICE, 'Alice Liddell')
    server.setDisplayName(BOB, 'Bob Stone')
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
  })

  it('puts the lines before an addressed message into its BodyForAgent, in order, with names, once', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(say(ALICE, 'кто сегодня дежурит?'))
    server.pushInbound(say('bot@srv', 'line from another instance on this account'))
    server.pushInbound(say(BOB, 'я дежурю'))
    server.pushInbound(ask(CAROL, 'запиши'))
    await waitFor(() => turnCount() >= 1)
    server.pushInbound(ask(ALICE, 'а завтра?'))
    await waitFor(() => turnCount() >= 2)

    expect(agentBodies()).toEqual([
      [
        CONTEXT,
        'Alice Liddell (alice@srv): кто сегодня дежурит?',
        'Bob Stone (bob@srv): я дежурю',
        '',
        CURRENT,
        'carol@srv: Bot запиши',
      ].join('\n'),
      'Alice Liddell (alice@srv): Bot а завтра?',
    ])
  })

  it('keeps a line that arrives while a turn runs for the next turn, and a running turn keeps its own lines', async () => {
    let finishFirst!: () => void
    groupDispatch.mockImplementationOnce(async (params) => {
      await (params as unknown as GroupTurn).afterRecord?.()
      await new Promise<void>((resolve) => { finishFirst = resolve })
      return {} as never
    })
    harness = await bootPlugin(server)

    server.pushInbound(say(ALICE, 'before the first question'))
    server.pushInbound(ask(BOB, 'first'))
    await waitFor(() => turnCount() >= 1)
    server.pushInbound(say(ALICE, 'while the first turn runs'))
    await settle(100)
    server.pushInbound(ask(BOB, 'second'))
    await waitFor(() => turnCount() >= 2)
    server.pushInbound(say(ALICE, 'still during the first turn'))
    await settle(100)
    finishFirst()
    await settle(50)
    server.pushInbound(ask(BOB, 'third'))
    await waitFor(() => turnCount() >= 3)

    expect(agentBodies()).toEqual([
      [CONTEXT, 'Alice Liddell (alice@srv): before the first question', '', CURRENT, 'Bob Stone (bob@srv): Bot first'].join('\n'),
      [CONTEXT, 'Alice Liddell (alice@srv): while the first turn runs', '', CURRENT, 'Bob Stone (bob@srv): Bot second'].join('\n'),
      [CONTEXT, 'Alice Liddell (alice@srv): still during the first turn', '', CURRENT, 'Bob Stone (bob@srv): Bot third'].join('\n'),
    ])
  })

  it('leaves a line sent after the addressed message, before its dispatch, for the next turn', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(ask(BOB, 'first'))
    await settle(50)
    server.pushInbound(say(ALICE, 'right after the question'))
    await waitFor(() => turnCount() >= 1)
    server.pushInbound(ask(BOB, 'second'))
    await waitFor(() => turnCount() >= 2)

    expect(agentBodies()).toEqual([
      'Bob Stone (bob@srv): Bot first',
      [CONTEXT, 'Alice Liddell (alice@srv): right after the question', '', CURRENT, 'Bob Stone (bob@srv): Bot second'].join('\n'),
    ])
  })

  it('does not repeat the lines when the agent run fails', async () => {
    groupDispatch.mockImplementationOnce(async (params) => {
      await (params as unknown as GroupTurn).afterRecord?.()
      throw new Error('model down')
    })
    harness = await bootPlugin(server)

    server.pushInbound(say(ALICE, 'context line'))
    server.pushInbound(ask(BOB, 'first'))
    await waitFor(() => turnCount() >= 1)
    await settle(50)
    server.pushInbound(ask(BOB, 'retry'))
    await waitFor(() => turnCount() >= 2)

    expect(agentBodies()).toEqual([
      [CONTEXT, 'Alice Liddell (alice@srv): context line', '', CURRENT, 'Bob Stone (bob@srv): Bot first'].join('\n'),
      'Bob Stone (bob@srv): Bot retry',
    ])
  })

  it('hands the lines back when the turn fails before the agent run starts', async () => {
    groupDispatch.mockRejectedValueOnce(new Error('session store unavailable'))
    harness = await bootPlugin(server)

    server.pushInbound(say(ALICE, 'context line'))
    server.pushInbound(ask(BOB, 'first'))
    await waitFor(() => turnCount() >= 1)
    await settle(50)
    server.pushInbound(ask(BOB, 'retry'))
    await waitFor(() => turnCount() >= 2)

    expect(agentBodies()[1]).toBe(
      [CONTEXT, 'Alice Liddell (alice@srv): context line', '', CURRENT, 'Bob Stone (bob@srv): Bot retry'].join('\n'),
    )
  })

  it('records files, forwards, locations and surveys as their placeholder text without downloading', async () => {
    harness = await bootPlugin(server)
    const envelope = (type: number, content: Record<string, unknown>) => ({ ...say(BOB, ''), type, content })

    server.pushInbound(envelope(202, { fileId: 'plan-1', name: 'plan.pdf', size: 10, mimeType: 'application/pdf', readyState: 2 }))
    server.pushInbound(envelope(201, { text: 'forwarded note', parseMode: 'text' }))
    server.pushInbound(envelope(203, { latitude: 55.75, longitude: 37.62 }))
    server.pushInbound(envelope(204, { title: 'Обед?' }))
    await settle(100)
    server.pushInbound(ask(ALICE, 'итоги'))
    await waitFor(() => turnCount() >= 1)

    expect({ body: agentBodies()[0], fileRequests: server.getFileInfoRequests.length }).toEqual({
      body: [
        CONTEXT,
        'Bob Stone (bob@srv): [File: plan.pdf]',
        'Bob Stone (bob@srv): forwarded note',
        'Bob Stone (bob@srv): [Локация: lat=55.75, lng=37.62]',
        'Bob Stone (bob@srv): [Опрос: «Обед?»]',
        '',
        CURRENT,
        'Alice Liddell (alice@srv): Bot итоги',
      ].join('\n'),
      fileRequests: 0,
    })
  })

  it('historyLimit: 2 keeps the last two lines', async () => {
    harness = await bootPlugin(server, { historyLimit: 2 })

    for (const text of ['one', 'two', 'three']) server.pushInbound(say(ALICE, text))
    await settle(100)
    server.pushInbound(ask(BOB, 'go'))
    await waitFor(() => turnCount() >= 1)

    expect(agentBodies()).toEqual([
      [CONTEXT, 'Alice Liddell (alice@srv): two', 'Alice Liddell (alice@srv): three', '', CURRENT, 'Bob Stone (bob@srv): Bot go'].join('\n'),
    ])
  })

  it('historyLimit: 0 keeps no lines', async () => {
    harness = await bootPlugin(server, { historyLimit: 0 })

    server.pushInbound(say(ALICE, 'not kept'))
    await settle(100)
    server.pushInbound(ask(BOB, 'go'))
    await waitFor(() => turnCount() >= 1)

    expect(agentBodies()).toEqual(['Bob Stone (bob@srv): Bot go'])
  })

  it('messages.groupChat.historyLimit applies when the channel sets none', async () => {
    harness = await bootPlugin(server, {}, { messages: { groupChat: { historyLimit: 1 } } })

    server.pushInbound(say(ALICE, 'dropped by the limit'))
    server.pushInbound(say(ALICE, 'kept'))
    await settle(100)
    server.pushInbound(ask(BOB, 'go'))
    await waitFor(() => turnCount() >= 1)

    expect(agentBodies()).toEqual([
      [CONTEXT, 'Alice Liddell (alice@srv): kept', '', CURRENT, 'Bob Stone (bob@srv): Bot go'].join('\n'),
    ])
  })

  it('keeps no lines from unserved groups or from senders outside the group allowlist', async () => {
    harness = await bootPlugin(server, { groupPolicy: 'allowlist', groupAllowFrom: [ALICE, CAROL], groups: { team: {} } })

    server.pushInbound(say(BOB, 'blocked sender'))
    server.pushInbound(say(ALICE, 'allowed sender'))
    server.pushInbound(say(ALICE, 'in a group this instance does not serve', 'foreign'))
    await settle(100)
    harness.reconfigure({ groupPolicy: 'allowlist', groupAllowFrom: [ALICE, CAROL], groups: { team: {}, foreign: {} } })
    server.pushInbound(ask(CAROL, 'now foreign is served', 'foreign'))
    await waitFor(() => turnCount() >= 1)
    server.pushInbound(ask(CAROL, 'and team'))
    await waitFor(() => turnCount() >= 2)

    expect(agentBodies()).toEqual([
      'carol@srv: Bot now foreign is served',
      [CONTEXT, 'Alice Liddell (alice@srv): allowed sender', '', CURRENT, 'carol@srv: Bot and team'].join('\n'),
    ])
  })
})
