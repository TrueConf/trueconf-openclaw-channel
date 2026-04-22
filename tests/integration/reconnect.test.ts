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
          dmPolicy: 'open',
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

describe('integration: reconnect after server-side terminate', () => {
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

  it('reauthenticates and keeps dispatching inbound after a mid-session drop', async () => {
    harness = await bootPlugin(server)
    expect(server.authRequests).toHaveLength(1)

    server.dropAll()
    await waitFor(() => server.connections.size === 0, 2000)
    await waitFor(() => server.authRequests.length >= 2 && server.connections.size >= 1, 10_000)

    server.pushInbound({
      type: 200,
      chatId: 'chat_bob@srv',
      author: { id: 'bob@srv', type: 1 },
      content: { text: 'after reconnect', parseMode: 'plain' },
      messageId: 'm-post',
      timestamp: 1,
    })

    await waitFor(() => dispatch.mock.calls.length >= 1, 5000)
    const arg = dispatch.mock.calls[0][0] as { rawBody: string; senderId: string }
    expect(arg.rawBody).toBe('after reconnect')
    expect(arg.senderId).toBe('bob@srv')
  })
})
