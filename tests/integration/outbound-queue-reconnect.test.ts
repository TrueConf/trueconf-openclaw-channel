import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import { __getAccountsForTesting, __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

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

describe('integration: OutboundQueue end-to-end', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
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

  it('routes outbound through queue without behavior change on healthy connection', async () => {
    harness = await bootPlugin(server)
    expect(server.authRequests).toHaveLength(1)

    const accounts = __getAccountsForTesting()
    const account = accounts.get('default')
    if (!account) throw new Error('account not found')

    const result = await account.outboundQueue.submit('sendMessage', {
      chatId: 'chat_alice@srv',
      content: { text: 'hello queue', parseMode: 'plain' },
    })
    expect(result.payload?.errorCode).toBe(0)
    expect(server.messageRequests.length).toBeGreaterThanOrEqual(1)
  }, 10_000)

  it('parks outbound while server is down, drains on reconnect', async () => {
    harness = await bootPlugin(server)
    expect(server.authRequests).toHaveLength(1)

    const accounts = __getAccountsForTesting()
    const account = accounts.get('default')
    if (!account) throw new Error('account not found')

    // Drop connections — server keeps listening for reconnect.
    server.dropAll()
    await waitFor(() => server.connections.size === 0, 2000)

    // Submit while disconnected — should park.
    const outboundPromise = account.outboundQueue.submit('sendMessage', {
      chatId: 'chat_alice@srv',
      content: { text: 'queued message', parseMode: 'plain' },
    })

    let settled = false
    void outboundPromise.finally(() => { settled = true })
    await new Promise((r) => setTimeout(r, 200))
    expect(settled).toBe(false)

    // Wait for reconnect — should drain.
    await waitFor(() => server.authRequests.length >= 2 && server.connections.size >= 1, 10_000)

    const result = await outboundPromise
    expect(result.payload?.errorCode).toBe(0)
  }, 15_000)

  it('outbound survives reconnect that exceeds default waitAuthenticated timeout', async () => {
    harness = await bootPlugin(server)
    expect(server.authRequests).toHaveLength(1)

    const accounts = __getAccountsForTesting()
    const account = accounts.get('default')
    if (!account) throw new Error('account not found')

    server.dropAll()
    await waitFor(() => server.connections.size === 0, 2000)

    // 5s reconnect delay — well past the 100ms park-tick boundary, well below
    // 30s waitAuthenticated default. Combined with park-on-timeout-prefix in the
    // queue, this proves the queue holds across a slow auth window.
    server.delayAuthBy(5000)

    const outboundPromise = account.outboundQueue.submit('sendMessage', {
      chatId: 'chat_alice@srv',
      content: { text: 'slow reconnect message', parseMode: 'plain' },
    })

    let settled = false
    void outboundPromise.finally(() => { settled = true })

    // 4s in — server still hasn't auth'd, queue should still hold.
    await new Promise((r) => setTimeout(r, 4000))
    expect(settled).toBe(false)

    const result = await outboundPromise
    expect(result.payload?.errorCode).toBe(0)
  }, 20_000)

  // DNS-terminal end-to-end coverage is provided by:
  // - tests/unit/ws-client.test.ts: 'fires onTerminalFailure after DNS_MAX_RETRIES exhausted'
  // - tests/unit/outbound-queue.test.ts: 'failAll(err) rejects all pending items and unsubscribes onAuth'
  // - tests/unit/outbound-queue.test.ts: 'submit after failAll throws terminal error immediately'
  // Wiring (channel.ts: onTerminalFailure → outboundQueue.failAll) is type-checked at
  // instantiation. End-to-end DNS-fail simulation in the channel harness adds significant
  // fixture complexity (mocked acquireToken, 5x retry budget, 60s+ backoff) for little
  // additional confidence.
})
