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

// Spy on prepareInboundAttachment so the dispatch missing-entry test can
// assert the early-return aborts before any attachment fetch is attempted.
// importOriginal preserves handleInboundMessage and the rest of the module
// since they drive the inbound flow that lands in dispatch.
vi.mock('../../src/inbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inbound')>()
  return { ...actual, prepareInboundAttachment: vi.fn() }
})

import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound'
import { prepareInboundAttachment } from '../../src/inbound'
import { __getAccountsForTesting, __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

const dispatch = vi.mocked(dispatchInboundDirectDmWithRuntime)

interface Harness {
  abort: () => void
  startPromise: Promise<void>
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
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
  return { abort: () => ac.abort(), startPromise, logger }
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

describe('integration: deliver — health-monitor restart race', () => {
  let server: FakeServer
  let harness1: Harness | null = null
  let harness2: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    dispatch.mockClear()
    server = await startFakeServer()
  })

  afterEach(async () => {
    for (const h of [harness2, harness1]) {
      if (!h) continue
      h.abort()
      await Promise.race([h.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
    }
    harness1 = null
    harness2 = null
    await server.close()
  })

  // Reproduces the documented coworker DX failure: an inbound message arrives,
  // the LLM run takes 4+ minutes, and openclaw's health-monitor restarts the
  // channel in between. The captured-in-closure outboundQueue from the original
  // startAccount points to a dead AccountEntry. Live-lookup in deliver routes
  // the reply through the new entry instead.
  it('routes the reply through the new AccountEntry after a health-monitor restart', async () => {
    harness1 = await bootPlugin(server)
    const entry1 = __getAccountsForTesting().get('default')
    if (!entry1) throw new Error('test setup: entry1 missing after first boot')
    const submit1Spy = vi.spyOn(entry1.outboundQueue, 'submit')

    const deliver1 = await captureDeliverFromInbound(server)

    // Tear down the first lifecycle the same way openclaw's health-monitor
    // would: AbortController fires, waitUntilAbort callback runs synchronously
    // (shutdownAccountEntry + accounts.delete), then the original startAccount
    // promise resolves.
    harness1.abort()
    await harness1.startPromise.catch(() => {})
    expect(__getAccountsForTesting().has('default')).toBe(false)

    // Boot a fresh harness on the SAME fake server. The new bootPlugin call
    // reuses module-scoped `store` (same `accountId`). registerFull replaces
    // store.logger; gateway.startAccount installs a fresh AccountEntry.
    harness2 = await bootPlugin(server)
    const entry2 = __getAccountsForTesting().get('default')
    if (!entry2) throw new Error('test setup: entry2 missing after second boot')
    expect(entry2).not.toBe(entry1)
    const submit2Spy = vi.spyOn(entry2.outboundQueue, 'submit')

    // Now the LLM "finishes" and calls the captured deliver. The fix routes
    // it through whichever entry is currently in the store.
    await deliver1({ text: 'reply after restart' })

    await waitFor(() => submit2Spy.mock.calls.length >= 1, 5000)
    expect(submit2Spy).toHaveBeenCalled()
    expect(submit1Spy).not.toHaveBeenCalled()
  })

  // Edge case: deliver fires while no AccountEntry is registered (the brief
  // window after abort cleanup runs and before the next startAccount installs
  // the new entry). Acceptable behaviour: warn + drop. No crash.
  it('drops the reply with a warn when no AccountEntry is registered', async () => {
    harness1 = await bootPlugin(server)
    const deliver1 = await captureDeliverFromInbound(server)

    harness1.abort()
    await harness1.startPromise.catch(() => {})
    expect(__getAccountsForTesting().has('default')).toBe(false)

    await deliver1({ text: 'reply with no entry' })

    expect(harness1.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('account default no longer registered'),
    )
    // Diagnostic: a future regression that double-warns, throws-then-swallows,
    // or drops-but-still-writes should fail one of these.
    expect(harness1.logger.warn).toHaveBeenCalledTimes(1)
    expect(harness1.logger.error).not.toHaveBeenCalled()
    expect(server.messageRequests).toHaveLength(0)
    expect(server.uploadFileRequests).toHaveLength(0)
    expect(server.sendFileRequests).toHaveLength(0)
  })
})

describe('integration: dispatch — health-monitor restart race', () => {
  let server: FakeServer
  let harness1: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    dispatch.mockClear()
    vi.mocked(prepareInboundAttachment).mockClear()
    server = await startFakeServer()
  })

  afterEach(async () => {
    if (harness1) {
      harness1.abort()
      await Promise.race([harness1.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness1 = null
    }
    await server.close()
  })

  // Mirrors the deliver-side missing-entry test for the inbound dispatch path.
  // Reproduces the dispatch-side race window: an attachment-bearing inbound is
  // routed via wsClient.onInboundMessage (the SDK's public assignable handler),
  // and the attachment branch must early-return when store.accounts no longer
  // has the account (post health-monitor teardown, pre next startAccount).
  // Also pins that no attachment fetch (prepareInboundAttachment) was attempted.
  it('drops the inbound with a warn when no AccountEntry is registered', async () => {
    harness1 = await bootPlugin(server)
    const entry1 = __getAccountsForTesting().get('default')
    if (!entry1) throw new Error('test setup: entry1 missing after first boot')
    const onInboundMessage = entry1.wsClient.onInboundMessage
    if (!onInboundMessage) throw new Error('test setup: onInboundMessage not wired')

    // Drive a PLAIN inbound first so resolveChatType caches chat_alice@srv as
    // 'p2p'. After teardown the wsClient is dead and getChatByID would never
    // resolve; the cache hit lets handleInboundMessage reach dispatch without
    // touching the wire.
    await captureDeliverFromInbound(server)
    dispatch.mockClear()

    // Tear down the lifecycle the same way openclaw's health-monitor would.
    harness1.abort()
    await harness1.startPromise.catch(() => {})
    expect(__getAccountsForTesting().has('default')).toBe(false)

    // Synthesize an attachment-bearing inbound. Routing IDs match the cached
    // P2P chat from the warm-up above so resolveChatType hits the cache.
    const synthesized = {
      type: 1 as const,
      id: 999,
      method: 'sendMessage',
      payload: {
        type: 202,
        chatId: 'chat_alice@srv',
        author: { id: 'alice@srv', type: 1 },
        content: {
          fileId: 'file-stranded',
          name: 'stranded.png',
          size: 10,
          mimeType: 'image/png',
          readyState: 2,
        },
        messageId: 'm-stranded',
        timestamp: Date.now(),
      },
    }
    await onInboundMessage(synthesized)
    // dispatchWithFence is fire-and-forget; await a microtask so the
    // synchronous-up-to-warn dispatch coroutine settles before assertions.
    await waitFor(() => harness1!.logger.warn.mock.calls.length >= 1, 1000)

    expect(harness1.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('account default no longer registered'),
    )
    expect(harness1.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('event=health_monitor_drop kind=dispatch'),
    )
    expect(harness1.logger.warn).toHaveBeenCalledTimes(1)
    expect(harness1.logger.error).not.toHaveBeenCalled()
    // The early-return must happen BEFORE the attachment fetch — no temp file
    // download attempt, no SDK dispatch downstream.
    expect(prepareInboundAttachment).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})
