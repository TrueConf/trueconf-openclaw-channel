import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound'
import {
  __resetForTesting,
  channelPlugin,
  registerFull,
} from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from './fake-server'

const dispatchMock = vi.mocked(dispatchInboundDirectDmWithRuntime)

interface Harness {
  abort: () => void
  startAccountPromise: Promise<void>
  triggerHook: (name: string) => Promise<void>
}

function makeApi(
  server: FakeServer,
  overrides: { dmPolicy?: string; allowFrom?: string[] } = {},
): { api: Record<string, unknown>; hooks: Record<string, Array<() => unknown>> } {
  const channelConfig: Record<string, unknown> = {
    serverUrl: server.serverUrl,
    port: server.port,
    useTls: false,
    username: 'bot@srv',
    password: 'secret',
    dmPolicy: overrides.dmPolicy ?? 'open',
  }
  if (overrides.allowFrom) channelConfig.allowFrom = overrides.allowFrom
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  const hooks: Record<string, Array<() => unknown>> = {}
  const noop = () => {}
  const api = {
    id: 'trueconf',
    name: 'TrueConf',
    source: 'smoke',
    registrationMode: 'full',
    logger,
    runtime: {},
    config: { channels: { trueconf: channelConfig } },
    on: (name: string, handler: () => unknown) => {
      ;(hooks[name] ??= []).push(handler)
    },
    registerTool: noop,
    registerHook: noop,
    registerHttpRoute: noop,
    registerChannel: noop,
    registerGatewayMethod: noop,
    registerCli: noop,
    registerService: noop,
    registerProvider: noop,
    registerSpeechProvider: noop,
    registerMediaUnderstandingProvider: noop,
    registerImageGenerationProvider: noop,
    registerWebSearchProvider: noop,
    registerInteractiveHandler: noop,
    onConversationBindingResolved: noop,
    registerCommand: noop,
    registerContextEngine: noop,
    registerMemoryPromptSection: noop,
    resolvePath: (s: string) => s,
  }
  return { api, hooks }
}

async function bootPlugin(
  server: FakeServer,
  overrides: { dmPolicy?: string; allowFrom?: string[] } = {},
): Promise<Harness> {
  const { api, hooks } = makeApi(server, overrides)
  registerFull(api as never)
  const abortController = new AbortController()
  const startAccountPromise = (channelPlugin.gateway.startAccount as (
    ctx: Record<string, unknown>,
  ) => Promise<void>)({
    accountId: 'default',
    setStatus: () => {},
    abortSignal: abortController.signal,
  })
  await waitFor(() => server.authRequests.length >= 1 && server.connections.size > 0)
  return {
    abort: () => abortController.abort(),
    startAccountPromise,
    triggerHook: async (name) => {
      for (const h of hooks[name] ?? []) await h()
    },
  }
}

describe('smoke: plugin end-to-end against a fake TrueConf server', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    dispatchMock.mockClear()
    server = await startFakeServer()
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([
        harness.startAccountPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 500)),
      ])
      harness = null
    }
    await server.close()
  })

  it('text roundtrip: inbound dispatches, outbound sendText reaches server', async () => {
    harness = await bootPlugin(server)

    server.pushInbound({
      type: 200,
      chatId: 'chat_alice@srv',
      author: { id: 'alice@srv', type: 1 },
      content: { text: 'hello', parseMode: 'plain' },
      messageId: 'm1',
      timestamp: 123,
    })

    await waitFor(() => dispatchMock.mock.calls.length >= 1)
    const call = dispatchMock.mock.calls[0][0] as { rawBody: string; senderId: string }
    expect(call.rawBody).toBe('hello')
    expect(call.senderId).toBe('alice@srv')
    expect(server.clientAcks).toContain(10_000)

    const sendText = channelPlugin.outbound.sendText as (
      ctx: { to: string; text: string; accountId: string },
    ) => Promise<{ channel: string; messageId: string }>
    const result = await sendText({ to: 'alice@srv', text: 'hi there', accountId: 'default' })

    expect(result.channel).toBe('trueconf')
    expect(result.messageId).toMatch(/^msg_/)
    await waitFor(() => server.messageRequests.length >= 1)
    const payload = server.messageRequests[0].payload as {
      chatId: string
      content: { text: string }
    }
    expect(payload.chatId).toMatch(/^chat_/)
    expect(payload.content.text).toBe('hi there')
  })

  it('inbound attachment: MediaPath appears in dispatch extraContext', async () => {
    harness = await bootPlugin(server)
    const fileBytes = Buffer.from('PNGDATA-smoke', 'utf8')
    server.setFile('file-42', { body: fileBytes, mimeType: 'image/png' })

    server.pushInbound({
      type: 202,
      chatId: 'chat_alice@srv',
      author: { id: 'alice@srv', type: 1 },
      content: {
        fileId: 'file-42',
        name: 'photo.png',
        size: fileBytes.length,
        mimeType: 'image/png',
        readyState: 2,
      },
      messageId: 'm2',
      timestamp: 456,
    })

    await waitFor(() => dispatchMock.mock.calls.length >= 1, 5000)
    const arg = dispatchMock.mock.calls[0][0] as {
      extraContext?: { MediaPath?: unknown; MediaType?: unknown }
    }
    expect(typeof arg.extraContext?.MediaPath).toBe('string')
    expect(arg.extraContext?.MediaType).toBe('image/png')
  })

  it('reconnect: server drops connection, plugin re-authenticates', async () => {
    harness = await bootPlugin(server)
    expect(server.authRequests.length).toBe(1)

    server.dropAll()
    await waitFor(() => server.connections.size === 0)
    await waitFor(() => server.authRequests.length >= 2, 5000)

    server.pushInbound({
      type: 200,
      chatId: 'chat_bob@srv',
      author: { id: 'bob@srv', type: 1 },
      content: { text: 'post-reconnect', parseMode: 'plain' },
      messageId: 'm3',
      timestamp: 789,
    })
    await waitFor(() => dispatchMock.mock.calls.length >= 1, 3000)
    const arg = dispatchMock.mock.calls[0][0] as { rawBody: string }
    expect(arg.rawBody).toBe('post-reconnect')
  })

  it('gateway_stop: closes all WebSocket connections', async () => {
    harness = await bootPlugin(server)
    expect(server.connections.size).toBe(1)

    await harness.triggerHook('gateway_stop')
    await waitFor(() => server.connections.size === 0, 2000)
  })

  it('dm policy allowlist: non-allowed senders are dropped', async () => {
    harness = await bootPlugin(server, { dmPolicy: 'allowlist', allowFrom: ['bob@srv'] })

    server.pushInbound({
      type: 200,
      chatId: 'chat_alice@srv',
      author: { id: 'alice@srv', type: 1 },
      content: { text: 'blocked', parseMode: 'plain' },
      messageId: 'm4',
      timestamp: 1,
    })
    server.pushInbound({
      type: 200,
      chatId: 'chat_bob@srv',
      author: { id: 'bob@srv', type: 1 },
      content: { text: 'allowed', parseMode: 'plain' },
      messageId: 'm5',
      timestamp: 2,
    })

    await waitFor(() => dispatchMock.mock.calls.length >= 1)
    await new Promise((r) => setTimeout(r, 150))
    expect(dispatchMock.mock.calls).toHaveLength(1)
    const arg = dispatchMock.mock.calls[0][0] as { senderId: string; rawBody: string }
    expect(arg.senderId).toBe('bob@srv')
    expect(arg.rawBody).toBe('allowed')
  })
})
