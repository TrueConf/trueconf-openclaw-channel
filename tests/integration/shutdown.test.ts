import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

interface Harness {
  abort: () => void
  startPromise: Promise<void>
  hooks: Record<string, Array<() => unknown>>
}

async function bootPlugin(server: FakeServer): Promise<Harness> {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const hooks: Record<string, Array<() => unknown>> = {}
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
    on: (name: string, handler: () => unknown) => {
      ;(hooks[name] ??= []).push(handler)
    },
  }
  registerFull(api as never)
  const ac = new AbortController()
  const startPromise = (channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>)({
    accountId: 'default',
    setStatus: () => {},
    abortSignal: ac.signal,
  })
  await waitFor(() => server.authRequests.length >= 1 && server.connections.size > 0)
  return { abort: () => ac.abort(), startPromise, hooks }
}

describe('integration: shutdown', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    server = await startFakeServer()
  })

  afterEach(async () => {
    await server.close()
  })

  it('abortSignal closes the WebSocket and startAccount resolves without throwing', async () => {
    harness = await bootPlugin(server)
    expect(server.connections.size).toBe(1)

    harness.abort()
    await expect(
      Promise.race([
        harness.startPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('startAccount hung')), 3000)),
      ]),
    ).resolves.toBeUndefined()

    await waitFor(() => server.connections.size === 0, 2000)
    harness = null
  })

  it('gateway_stop hook closes all connections', async () => {
    harness = await bootPlugin(server)
    expect(server.connections.size).toBe(1)

    for (const handler of harness.hooks.gateway_stop ?? []) await handler()
    await waitFor(() => server.connections.size === 0, 2000)

    harness.abort()
    await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
    harness = null
  })
})
