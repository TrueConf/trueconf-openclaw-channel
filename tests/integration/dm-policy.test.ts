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

async function bootPlugin(server: FakeServer, policyOverride: Record<string, unknown>): Promise<Harness> {
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
          ...policyOverride,
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

function textEnvelope(senderId: string, text: string, messageId: string) {
  return {
    type: 200,
    chatId: `chat_${senderId}`,
    author: { id: senderId, type: 1 },
    content: { text, parseMode: 'plain' },
    messageId,
    timestamp: Date.now(),
  }
}

describe('integration: DM policy allowlist', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    dispatch.mockClear()
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

  it('blocks inbound from a sender outside allowFrom and lets allowed senders through', async () => {
    harness = await bootPlugin(server, { dmPolicy: 'allowlist', allowFrom: ['bob@srv'] })

    server.pushInbound(textEnvelope('alice@srv', 'blocked', 'm-a'))
    server.pushInbound(textEnvelope('bob@srv', 'allowed', 'm-b'))

    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    await new Promise((r) => setTimeout(r, 150))

    expect(dispatch.mock.calls).toHaveLength(1)
    const arg = dispatch.mock.calls[0][0] as { senderId: string; rawBody: string }
    expect(arg.senderId).toBe('bob@srv')
    expect(arg.rawBody).toBe('allowed')
  })

  it('closed policy drops everything', async () => {
    harness = await bootPlugin(server, { dmPolicy: 'closed' })

    server.pushInbound(textEnvelope('alice@srv', 'nope', 'm-c1'))
    server.pushInbound(textEnvelope('bob@srv', 'nope', 'm-c2'))

    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })
})
