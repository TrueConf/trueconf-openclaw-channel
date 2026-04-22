import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'

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

function attachmentEnvelope(fileId: string, name: string, size: number, mimeType: string, readyState: number) {
  return {
    type: 202,
    chatId: 'chat_alice@srv',
    author: { id: 'alice@srv', type: 1 },
    content: { fileId, name, size, mimeType, readyState },
    messageId: `m-${fileId}`,
    timestamp: Date.now(),
  }
}

describe('integration: inbound attachments', () => {
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

  it('READY file: dispatch has MediaPath pointing at downloaded bytes', async () => {
    harness = await bootPlugin(server)
    const bytes = Buffer.from('PNGDATA-ready', 'utf8')
    server.setFile('file-ready', { body: bytes, mimeType: 'image/png' })

    server.pushInbound(attachmentEnvelope('file-ready', 'photo.png', bytes.length, 'image/png', 2))

    await waitFor(() => dispatch.mock.calls.length >= 1, 5000)
    const arg = dispatch.mock.calls[0][0] as {
      extraContext?: { MediaPath?: string; MediaType?: string }
    }
    expect(arg.extraContext?.MediaType).toBe('image/png')
    expect(typeof arg.extraContext?.MediaPath).toBe('string')
    const info = await stat(arg.extraContext!.MediaPath!)
    expect(info.size).toBe(bytes.length)
  })

  it('UPLOADING → uploadFileProgress → READY: plugin subscribes, waits for progress event, then dispatches', async () => {
    harness = await bootPlugin(server)
    const bytes = Buffer.from('PNGDATA-progress-flow', 'utf8')
    server.setFile('file-progress', { body: bytes, mimeType: 'image/png' })
    // Initial getFileInfo returns UPLOADING. After the plugin subscribes we
    // push an uploadFileProgress event with progress=size; the subsequent
    // getFileInfo (pollForReady) returns READY with an auto-filled downloadUrl.
    server.setFileInfoSequence('file-progress', [
      { readyState: 1, size: bytes.length, mimeType: 'image/png' },
      { readyState: 2, size: bytes.length, mimeType: 'image/png' },
    ])

    server.pushInbound(attachmentEnvelope('file-progress', 'photo.png', bytes.length, 'image/png', 1))
    await waitFor(() => server.subscribeFileProgressRequests.length >= 1, 3000)
    server.pushFileProgress('file-progress', bytes.length)

    await waitFor(() => dispatch.mock.calls.length >= 1, 5000)
    const arg = dispatch.mock.calls[0][0] as { extraContext?: { MediaPath?: string } }
    expect(typeof arg.extraContext?.MediaPath).toBe('string')
    const info = await stat(arg.extraContext!.MediaPath!)
    expect(info.size).toBe(bytes.length)
    // Plugin should clean up its subscription after progress arrived.
    await waitFor(() => server.unsubscribeFileProgressRequests.length >= 1, 2000)
  })

  it('NOT_AVAILABLE: no dispatch, plugin sends an error text back to the chat', async () => {
    harness = await bootPlugin(server)
    server.setFileInfoSequence('file-gone', [{ readyState: 0 }])

    server.pushInbound(attachmentEnvelope('file-gone', 'gone.png', 10, 'image/png', 1))

    await waitFor(() => server.messageRequests.length >= 1, 4000)
    expect(dispatch).not.toHaveBeenCalled()
    const payload = server.messageRequests[0].payload as { content: { text: string } }
    expect(payload.content.text.length).toBeGreaterThan(0)
  })
})
