import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Routing, envelope and context building are OpenClaw's own. Only the final
// dispatch is replaced, so no agent or model runs.
vi.mock('openclaw/plugin-sdk/channel-inbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openclaw/plugin-sdk/channel-inbound')>()
  return {
    ...actual,
    dispatchChannelInboundTurn: vi.fn().mockResolvedValue({}),
    // dispatchInboundDirectDm routes and dispatches internally, so this
    // stand-in runs only its routing step, the same call with the same params.
    dispatchInboundDirectDm: vi.fn(async (params: Parameters<typeof actual.dispatchInboundDirectDm>[0]) => ({
      route: actual.resolveChannelInboundRouteEnvelope({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
        peer: params.peer,
      }).route,
    })),
  }
})

import { dispatchChannelInboundTurn, dispatchInboundDirectDm } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

const dmDispatch = vi.mocked(dispatchInboundDirectDm)
const groupDispatch = vi.mocked(dispatchChannelInboundTurn)

const GROUP_CHAT = 'e28a99f1c0d34b7a'
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
    expect(plan.route.sessionKey).toBe(`agent:main:trueconf:group:${GROUP_CHAT}`)
    expect(plan.ctxPayload).toMatchObject({
      SessionKey: `agent:main:trueconf:group:${GROUP_CHAT}`,
      ChatType: 'group',
      ChatId: GROUP_CHAT,
      ConversationLabel: `Group ${GROUP_CHAT}`,
      SenderId: ALICE,
      RawBody: 'Bot status?',
      WasMentioned: true,
      To: 'bot@srv',
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

    await waitFor(() => dmDispatch.mock.calls.length >= 1, 5000)
    expect(dmDispatch.mock.calls[0][0].peer).toEqual({ kind: 'direct', id: ALICE })
    const { route } = await dmDispatch.mock.results[0].value
    expect(route.sessionKey).toBe('agent:main:main')
    expect(groupDispatch).not.toHaveBeenCalled()
  })
})
