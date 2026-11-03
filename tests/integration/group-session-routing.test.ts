import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Routing, envelope and context building are OpenClaw's own. Only the final
// dispatch is replaced, so no agent or model runs.
vi.mock('openclaw/plugin-sdk/channel-inbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openclaw/plugin-sdk/channel-inbound')>()
  const stop = new Error('DM context captured')
  return {
    ...actual,
    dispatchChannelInboundTurn: vi.fn().mockResolvedValue({}),
    // The real dispatchInboundDirectDm, halted once it has built the context:
    // the builder it accepts through channelRuntime records the real context
    // and throws before the turn is dispatched.
    dispatchInboundDirectDm: vi.fn(async (params: Parameters<typeof actual.dispatchInboundDirectDm>[0]) => {
      let ctxPayload: Record<string, unknown> | undefined
      const buildContext = async (input: Parameters<typeof actual.buildChannelInboundEventContext>[0]) => {
        ctxPayload = await actual.buildChannelInboundEventContext(input)
        throw stop
      }
      await actual.dispatchInboundDirectDm({ ...params, channelRuntime: { inbound: { buildContext } } }).catch((err) => {
        if (err !== stop) throw err
      })
      return { ctxPayload }
    }),
  }
})

import { dispatchChannelInboundTurn, dispatchInboundDirectDm } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

const dmDispatch = vi.mocked(dispatchInboundDirectDm)
const groupDispatch = vi.mocked(dispatchChannelInboundTurn)

const GROUP_CHAT = 'e28a99f1c0d34b7a'
const ALICE = 'alice@srv'

type Context = Record<string, unknown>

interface Harness {
  abort: () => void
  startPromise: Promise<void>
}

async function bootPlugin(server: FakeServer, trueconf: Record<string, unknown> = {}): Promise<Harness> {
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
  return { abort: () => ac.abort(), startPromise }
}

async function dmContext(): Promise<Context> {
  await waitFor(() => dmDispatch.mock.calls.length >= 1, 5000)
  const { ctxPayload } = await (dmDispatch.mock.results[0].value as Promise<{ ctxPayload: Context }>)
  return ctxPayload
}

async function groupContext(): Promise<Context> {
  await waitFor(() => groupDispatch.mock.calls.length >= 1, 5000)
  return groupDispatch.mock.calls[0][0].ctxPayload as Context
}

const definedKeys = (ctx: Context): string[] => Object.keys(ctx).filter((k) => ctx[k] !== undefined)

describe('integration: session routing with real OpenClaw routing', () => {
  let stateDir: string
  let server: FakeServer
  let harness: Harness | null = null

  // The envelope builder reads the session store; keep it off the real ~/.openclaw.
  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'tc-routing-state-'))
    vi.stubEnv('OPENCLAW_STATE_DIR', stateDir)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    try {
      rmSync(stateDir, { recursive: true, force: true })
    } catch {
      // Windows keeps the session database open until the worker exits.
    }
  })

  beforeEach(async () => {
    __resetForTesting()
    dmDispatch.mockClear()
    groupDispatch.mockClear()
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

  it('a group message gets its own group session, not the main DM session', async () => {
    harness = await bootPlugin(server)

    server.pushInbound({
      type: 200,
      chatId: GROUP_CHAT,
      author: { id: ALICE, type: 1 },
      content: { text: '<a href="trueconf:bot@srv">Bot</a> status?', parseMode: 'html' },
      messageId: 'g1',
      timestamp: Date.now(),
    })

    await waitFor(() => groupDispatch.mock.calls.length >= 1, 5000)
    const plan = groupDispatch.mock.calls[0][0]
    expect(plan.route.sessionKey).toBe('agent:main:trueconf:group:e28a99f1c0d34b7a')
    expect(plan.ctxPayload).toMatchObject({
      SessionKey: 'agent:main:trueconf:group:e28a99f1c0d34b7a',
      ChatType: 'group',
      ChatId: GROUP_CHAT,
      ConversationLabel: 'Group e28a99f1c0d34b7a',
      SenderId: ALICE,
      RawBody: 'Bot status?',
      WasMentioned: true,
      GroupRequireMention: true,
      From: 'trueconf:group:e28a99f1c0d34b7a',
      To: 'trueconf:group:e28a99f1c0d34b7a',
      OriginatingTo: 'trueconf:group:e28a99f1c0d34b7a',
    })
    expect(dmDispatch).not.toHaveBeenCalled()
  })

  it('a DM still routes as direct into the main session under the default dmScope', async () => {
    harness = await bootPlugin(server)

    server.pushInbound({
      type: 200,
      chatId: 'chat_alice@srv',
      author: { id: ALICE, type: 1 },
      content: { text: 'hello', parseMode: 'text' },
      messageId: 'd1',
      timestamp: Date.now(),
    })

    expect(await dmContext()).toMatchObject({
      SessionKey: 'agent:main:main',
      ChatType: 'direct',
      From: ALICE,
      To: 'bot@srv',
      OriginatingTo: ALICE,
    })
    expect(groupDispatch).not.toHaveBeenCalled()
  })

  // Fails when OpenClaw starts filling a DM context field that the group path
  // does not supply, or when the two paths drift on a shared field.
  it('the same message builds the same context in a DM and a group, except for the group facts', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: [`chatId:${GROUP_CHAT}`] })
    const message = {
      type: 200,
      author: { id: ALICE, type: 1 },
      content: { text: 'hello', parseMode: 'text' },
      messageId: 'same-1',
      timestamp: 1767225600000,
    }

    server.pushInbound({ ...message, chatId: 'chat_alice@srv' })
    const dm = await dmContext()
    server.pushInbound({ ...message, chatId: GROUP_CHAT })
    const group = await groupContext()

    const dmKeys = definedKeys(dm)
    const groupKeys = definedKeys(group)
    expect({
      dmOnly: dmKeys.filter((k) => !groupKeys.includes(k)).sort(),
      groupOnly: groupKeys.filter((k) => !dmKeys.includes(k)).sort(),
    }).toEqual({
      dmOnly: ['NativeDirectUserId'],
      groupOnly: ['GroupRequireMention', 'GroupSubject', 'WasMentioned'],
    })

    // [DM value, group value] for every shared key whose values differ.
    const differing = Object.fromEntries(
      dmKeys.filter((k) => groupKeys.includes(k) && !isDeepStrictEqual(dm[k], group[k])).map((k) => [k, [dm[k], group[k]]]),
    )
    expect(differing).toEqual({
      // The envelope timestamp is rendered in the machine's time zone.
      Body: [
        expect.stringMatching(/^\[TrueConf DM with alice@srv .+\] hello$/),
        expect.stringMatching(/^\[TrueConf Group e28a99f1c0d34b7a .+\] hello$/),
      ],
      ChatId: ['alice@srv', 'e28a99f1c0d34b7a'],
      ChatType: ['direct', 'group'],
      ConversationLabel: ['DM with alice@srv', 'Group e28a99f1c0d34b7a'],
      ConversationRoutePeerId: ['alice@srv', 'e28a99f1c0d34b7a'],
      From: ['alice@srv', 'trueconf:group:e28a99f1c0d34b7a'],
      OriginatingTo: ['alice@srv', 'trueconf:group:e28a99f1c0d34b7a'],
      SenderName: ['DM with alice@srv', 'alice@srv'],
      SessionKey: ['agent:main:main', 'agent:main:trueconf:group:e28a99f1c0d34b7a'],
      To: ['bot@srv', 'trueconf:group:e28a99f1c0d34b7a'],
    })
    expect({ dm: dm.NativeDirectUserId, group: [group.GroupSubject, group.WasMentioned, group.GroupRequireMention] }).toEqual({
      dm: 'alice@srv',
      group: ['Group e28a99f1c0d34b7a', false, false],
    })
  })
})
