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

describe('integration: text roundtrip', () => {
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

  it('inbound text dispatches with rawBody and senderId', async () => {
    harness = await bootPlugin(server)

    server.pushInbound({
      type: 200,
      chatId: 'chat_alice@srv',
      author: { id: 'alice@srv', type: 1 },
      content: { text: 'hello', parseMode: 'plain' },
      messageId: 'm1',
      timestamp: 1,
    })

    await waitFor(() => dispatch.mock.calls.length >= 1)
    const call = dispatch.mock.calls[0][0] as { rawBody: string; senderId: string }
    expect(call.rawBody).toBe('hello')
    expect(call.senderId).toBe('alice@srv')
    expect(server.clientAcks).toContain(10_000)
  })

  it('outbound sendText delivers sanitized markdown to the server', async () => {
    harness = await bootPlugin(server)

    const sendText = channelPlugin.outbound.sendText as (
      ctx: { to: string; text: string; accountId: string },
    ) => Promise<{ channel: string; messageId: string }>

    const reply = await sendText({ to: 'alice@srv', text: '**bold** and *italic*', accountId: 'default' })
    expect(reply.channel).toBe('trueconf')
    expect(reply.messageId).toMatch(/^msg_/)

    await waitFor(() => server.messageRequests.length >= 1)
    const payload = server.messageRequests[0].payload as {
      chatId: string
      content: { text: string; parseMode: string }
    }
    expect(payload.chatId).toBe('chat_alice@srv')
    expect(payload.content.text).toBe('bold and italic')
  })

  it('deliver callback invoked with dispatch payload produces a reply on the wire', async () => {
    harness = await bootPlugin(server)

    dispatch.mockImplementationOnce(async (arg: { deliver?: (payload: { text: string }) => Promise<void> }) => {
      if (arg.deliver) await arg.deliver({ text: 'auto-reply' })
      return {} as never
    })

    server.pushInbound({
      type: 200,
      chatId: 'chat_alice@srv',
      author: { id: 'alice@srv', type: 1 },
      content: { text: 'ping', parseMode: 'plain' },
      messageId: 'm2',
      timestamp: 2,
    })

    await waitFor(() => server.messageRequests.length >= 1, 4000)
    const payload = server.messageRequests[0].payload as { content: { text: string } }
    expect(payload.content.text).toBe('auto-reply')
  })
})
