import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

// loadOutboundMediaFromUrl applies the SDK's strict SSRF guard, which rejects
// loopback addresses; bypass it for these tests since we're exercising the
// deliver routing logic, not the remote-fetch policy. Returns a fixed buffer
// regardless of the URL the deliver hands down.
vi.mock('../../src/load-media', () => ({
  loadOutboundMediaFromUrl: vi.fn().mockResolvedValue({
    buffer: Buffer.from('FAKE-MEDIA-BYTES'),
    contentType: 'application/octet-stream',
    fileName: 'fake.bin',
  }),
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

type DeliverFn = (payload: Record<string, unknown>) => Promise<void>

async function captureDeliverFromInbound(server: FakeServer, peerId = 'alice@srv'): Promise<DeliverFn> {
  server.pushInbound({
    type: 200,
    chatId: `chat_${peerId}`,
    author: { id: peerId, type: 1 },
    content: { text: 'hi', parseMode: 'plain' },
    messageId: 'm1',
    timestamp: 1,
  })
  await waitFor(() => dispatch.mock.calls.length >= 1)
  const params = dispatch.mock.calls[0][0] as { deliver: DeliverFn }
  return params.deliver
}

// Group routing of deliver is already covered end-to-end in
// group-outbound.test.ts via handleOutboundAttachmentToChat / sendTextToChat;
// reproducing it here would require driving the inbound mention-gating path,
// which is out of scope for this file.

describe('integration: deliver — OutboundReplyPayload routing', () => {
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

  // Reproduces the reported bug: agent emits a MEDIA: directive, runtime
  // normalizes it to {mediaUrl, mediaUrls, replyToId} (no text), the previous
  // deliver implementation JSON.stringify'd it and the user saw raw JSON in
  // chat instead of the photo.
  it('routes media-only payload through sendFile, not as JSON text', async () => {
    harness = await bootPlugin(server)
    const mediaUrl = 'https://cataas.com/cat'

    const deliver = await captureDeliverFromInbound(server)
    await deliver({ mediaUrl, mediaUrls: [mediaUrl], replyToId: 'm1' })

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)
    expect(server.uploadFileRequests).toHaveLength(1)
    expect(server.sendFileRequests).toHaveLength(1)

    // Critical assertion: the JSON envelope must NOT have been sent as plain
    // text via sendMessage. messageRequests must be empty for this turn.
    expect(server.messageRequests).toHaveLength(0)
  })

  it('routes text-only payload through sendMessage with the trimmed text', async () => {
    harness = await bootPlugin(server)

    const deliver = await captureDeliverFromInbound(server)
    await deliver({ text: 'hello world' })

    await waitFor(() => server.messageRequests.length >= 1, 5000)
    const payload = server.messageRequests[0].payload as { content: { text: string } }
    expect(payload.content.text).toBe('hello world')
    expect(server.uploadFileRequests).toHaveLength(0)
    expect(server.sendFileRequests).toHaveLength(0)
  })

  it('routes mixed text+media payload through sendFile with caption=text', async () => {
    harness = await bootPlugin(server)
    const mediaUrl = 'https://example.com/doc.pdf'

    const deliver = await captureDeliverFromInbound(server)
    await deliver({ text: 'see attached', mediaUrl, mediaUrls: [mediaUrl] })

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)
    const sendFile = server.sendFileRequests[0].payload as {
      content: { caption?: { text: string } }
    }
    expect(sendFile.content.caption?.text).toBe('see attached')
    expect(server.messageRequests).toHaveLength(0)
  })

  it('handles empty payload as a no-op (no WS write)', async () => {
    harness = await bootPlugin(server)

    const deliver = await captureDeliverFromInbound(server)
    await deliver({})

    // Nothing should hit the wire.
    expect(server.messageRequests).toHaveLength(0)
    expect(server.uploadFileRequests).toHaveLength(0)
    expect(server.sendFileRequests).toHaveLength(0)
  })

  // sendMediaWithLeadingCaption invokes sendMedia once per mediaUrl with
  // caption only on the first; protect that contract from a future helper
  // refactor that might re-emit the caption on every iteration.
  it('routes multi-media payload through one sendFile per URL with caption only on the first', async () => {
    harness = await bootPlugin(server)
    const mediaUrls = ['https://example.com/a.png', 'https://example.com/b.png', 'https://example.com/c.png']

    const deliver = await captureDeliverFromInbound(server)
    await deliver({ text: 'three of them', mediaUrls })

    await waitFor(() => server.sendFileRequests.length >= 3, 5000)
    expect(server.sendFileRequests).toHaveLength(3)
    const captions = server.sendFileRequests.map(
      (r) => (r.payload as { content: { caption?: { text: string } } }).content.caption?.text,
    )
    expect(captions).toEqual(['three of them', undefined, undefined])
    expect(server.messageRequests).toHaveLength(0)
  })

  // The channel doesn't support threads (capabilities.threads: false), so
  // replyToId on the payload must not leak into the WS sendFile/sendMessage
  // frames as a thread/reply pointer. Locks the current behavior so a future
  // "wire reply-to" change is intentional, not accidental.
  it('does not propagate replyToId into the WS frame', async () => {
    harness = await bootPlugin(server)
    const mediaUrl = 'https://example.com/x.png'

    const deliver = await captureDeliverFromInbound(server)
    await deliver({ mediaUrl, mediaUrls: [mediaUrl], replyToId: 'inbound-msg-id-42' })

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)
    const sendFile = server.sendFileRequests[0].payload as Record<string, unknown>
    // Server-side sendFile uses replyMessageId, not replyToId. Plugin sets it
    // to null today; either null or absent is acceptable, but the inbound id
    // must never appear as the value.
    expect(sendFile.replyMessageId ?? null).toBeNull()
    expect(JSON.stringify(sendFile)).not.toContain('inbound-msg-id-42')
  })
})
