import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', async () =>
  (await import('./__helpers__/channel-inbound-mock')).channelInboundMock())

import { dispatchInboundDirectDm } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

const dmDispatch = vi.mocked(dispatchInboundDirectDm)

describe('integration: DM dispatch payload', () => {
  let server: FakeServer
  let abort: (() => void) | null = null
  let startPromise: Promise<void> | null = null

  beforeEach(async () => {
    __resetForTesting()
    dmDispatch.mockClear()
    server = await startFakeServer()
  })

  afterEach(async () => {
    abort?.()
    await Promise.race([startPromise?.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
    abort = null
    startPromise = null
    await server.close()
  })

  it('a plain DM reaches dispatchInboundDirectDm with the same params as before group sessions', async () => {
    const config = {
      channels: {
        trueconf: {
          serverUrl: server.serverUrl,
          port: server.port,
          useTls: false,
          username: 'bot@srv',
          password: 'secret',
        },
      },
    }
    registerFull({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {},
      config,
      on: () => {},
      registerTool: () => {},
    } as never)
    const ac = new AbortController()
    abort = () => ac.abort()
    startPromise = (channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>)({
      accountId: 'default',
      setStatus: () => {},
      abortSignal: ac.signal,
    })
    await waitFor(() => server.authRequests.length >= 1 && server.connections.size > 0)

    server.pushInbound({
      type: 200,
      chatId: 'chat_alice@srv',
      author: { id: 'alice@srv/phone', type: 1 },
      content: { text: 'hello bot', parseMode: 'text' },
      messageId: 'dm-1',
      timestamp: 1767225600000,
    })

    await waitFor(() => dmDispatch.mock.calls.length >= 1, 3000)
    expect(dmDispatch.mock.calls[0][0]).toEqual({
      cfg: config,
      channel: 'trueconf',
      channelLabel: 'TrueConf',
      accountId: 'default',
      peer: { kind: 'direct', id: 'alice@srv' },
      senderId: 'alice@srv',
      senderAddress: 'alice@srv',
      recipientAddress: 'bot@srv',
      conversationLabel: 'DM with alice@srv',
      rawBody: 'hello bot',
      messageId: 'dm-1',
      timestamp: 1767225600000,
      deliver: expect.any(Function),
      onRecordError: expect.any(Function),
      onDispatchError: expect.any(Function),
    })
  })
})
