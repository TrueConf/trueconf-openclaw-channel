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

describe('integration: text+attachment coalesce for same peer+chat', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    dispatch.mockClear()
    server = await startFakeServer()
    server.setFile('f_pic1', { body: Buffer.from('PIXELS'), mimeType: 'image/png' })
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
  })

  it('merges text (200) + attachment (202) from same chat into a single dispatch with caption preserved', async () => {
    harness = await bootPlugin(server)

    // Simulate TrueConf delivering an image-with-caption as two envelopes in one tick.
    server.pushInbound({
      type: 200,
      chatId: 'chat_alice@srv',
      author: { id: 'alice@srv', type: 1 },
      content: { text: 'видишь картинку?', parseMode: 'plain' },
      messageId: 'm-text',
      timestamp: 1,
    })
    server.pushInbound({
      type: 202,
      chatId: 'chat_alice@srv',
      author: { id: 'alice@srv', type: 1 },
      content: { name: 'pic.png', mimeType: 'image/png', fileId: 'f_pic1', size: 6 },
      messageId: 'm-attach',
      timestamp: 1,
    })

    // Wait for the plugin to dispatch — expect exactly ONE dispatch after coalesce window.
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    // Let the coalesce timer expire in case a second dispatch is wrongly scheduled.
    await new Promise((r) => setTimeout(r, 600))

    expect(dispatch.mock.calls).toHaveLength(1)
    const call = dispatch.mock.calls[0][0] as {
      rawBody: string
      senderId: string
      extraContext?: Record<string, unknown>
    }
    // Caption from the 200 envelope must be preserved as the LLM body,
    // not overwritten with a synthetic "[Image: pic.png]" placeholder.
    expect(call.rawBody).toBe('видишь картинку?')
    expect(call.senderId).toBe('alice@srv')
    // The attachment context must still be present so the agent sees the image.
    expect(call.extraContext).toBeDefined()
    expect(call.extraContext!.MediaPath).toBeDefined()
    expect(String(call.extraContext!.MediaType)).toBe('image/png')
  })
})
