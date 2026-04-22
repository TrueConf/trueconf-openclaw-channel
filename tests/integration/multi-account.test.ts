import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

const dispatch = vi.mocked(dispatchInboundDirectDmWithRuntime)

interface Harness {
  abortA: () => void
  abortB: () => void
  pA: Promise<void>
  pB: Promise<void>
}

async function bootMultiAccount(a: FakeServer, b: FakeServer): Promise<Harness> {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const api = {
    logger,
    runtime: {},
    config: {
      channels: {
        trueconf: {
          accounts: {
            A: { serverUrl: a.serverUrl, port: a.port, useTls: false, username: 'botA@srv', password: 'secret' },
            B: { serverUrl: b.serverUrl, port: b.port, useTls: false, username: 'botB@srv', password: 'secret' },
          },
          dmPolicy: 'open',
        },
      },
    },
    on: () => {},
  }
  registerFull(api as never)
  const acA = new AbortController()
  const acB = new AbortController()
  const start = channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>
  const pA = start({ accountId: 'A', setStatus: () => {}, abortSignal: acA.signal })
  const pB = start({ accountId: 'B', setStatus: () => {}, abortSignal: acB.signal })
  await waitFor(() => a.authRequests.length >= 1 && b.authRequests.length >= 1 && a.connections.size >= 1 && b.connections.size >= 1, 4000)
  return { abortA: () => acA.abort(), abortB: () => acB.abort(), pA, pB }
}

describe('integration: multi-account isolation', () => {
  let serverA: FakeServer
  let serverB: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    dispatch.mockClear()
    serverA = await startFakeServer({ botUserId: 'botA@srv' })
    serverB = await startFakeServer({ botUserId: 'botB@srv' })
  })

  afterEach(async () => {
    if (harness) {
      harness.abortA()
      harness.abortB()
      await Promise.race([
        Promise.all([harness.pA.catch(() => {}), harness.pB.catch(() => {})]),
        new Promise((r) => setTimeout(r, 800)),
      ])
      harness = null
    }
    await Promise.all([serverA.close(), serverB.close()])
  })

  it('inbound on A dispatches with accountId=A; outbound via B hits B only', async () => {
    harness = await bootMultiAccount(serverA, serverB)

    serverA.pushInbound({
      type: 200,
      chatId: 'chat_alice@srv',
      author: { id: 'alice@srv', type: 1 },
      content: { text: 'hello from A side', parseMode: 'plain' },
      messageId: 'm-a',
      timestamp: 1,
    })

    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    const arg = dispatch.mock.calls[0][0] as { accountId: string; rawBody: string }
    expect(arg.accountId).toBe('A')
    expect(arg.rawBody).toBe('hello from A side')

    const sendText = channelPlugin.outbound.sendText as (
      ctx: { to: string; text: string; accountId: string },
    ) => Promise<{ channel: string; messageId: string }>
    await sendText({ to: 'carol@srv', text: 'outbound via B', accountId: 'B' })

    await waitFor(() => serverB.messageRequests.length >= 1, 3000)
    expect(serverA.messageRequests).toHaveLength(0)
    const payload = serverB.messageRequests[0].payload as { content: { text: string } }
    expect(payload.content.text).toBe('outbound via B')
  })
})
