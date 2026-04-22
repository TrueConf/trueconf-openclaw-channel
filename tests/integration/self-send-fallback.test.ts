import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

async function pushInboundAndWaitDispatch(server: FakeServer, authorId: string, messageId: string): Promise<void> {
  const dispatchCountBefore = dispatch.mock.calls.length
  server.pushInbound({
    type: 200,
    chatId: `chat_${authorId}`,
    author: { id: authorId, type: 1 },
    content: { text: 'user said something', parseMode: 'plain' },
    messageId,
    timestamp: 1,
  })
  await waitFor(() => dispatch.mock.calls.length > dispatchCountBefore)
}

type SendMedia = (ctx: Record<string, unknown>) => Promise<{ channel: string; messageId: string }>

describe('integration: outbound self-send fallback to last inbound peer', () => {
  let server: FakeServer
  let harness: Harness | null = null
  let workDir: string

  beforeEach(async () => {
    __resetForTesting()
    dispatch.mockClear()
    server = await startFakeServer()
    workDir = await mkdtemp(join(tmpdir(), 'tc-self-'))
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  it('redirects to last inbound peer when ctx.to equals bot identity', async () => {
    harness = await bootPlugin(server)

    // Simulate a real user sending the bot a message — plugin caches alice as last inbound peer.
    await pushInboundAndWaitDispatch(server, 'alice@srv', 'm1')

    // Simulate the known gateway routing bug: tool-path outbound where ctx.to resolves
    // to the bot's own identity (taken from ctxPayload.To) instead of the real sender.
    const sendText = channelPlugin.outbound.sendText as (
      ctx: { to: string; text: string; accountId: string },
    ) => Promise<{ channel: string; messageId: string }>

    const reply = await sendText({ to: 'bot@srv', text: 'hello from the agent', accountId: 'default' })
    expect(reply.channel).toBe('trueconf')
    expect(reply.messageId).toMatch(/^msg_/)

    await waitFor(() => server.messageRequests.length >= 1)
    const payload = server.messageRequests[0].payload as {
      chatId: string
      content: { text: string }
    }
    expect(payload.chatId).toBe('chat_alice@srv')
    expect(payload.content.text).toBe('hello from the agent')
  })

  it('delivers unchanged when ctx.to is a real peer (no redirect)', async () => {
    harness = await bootPlugin(server)

    // Two inbounds from different users — the cache holds the LATEST one (carol).
    await pushInboundAndWaitDispatch(server, 'alice@srv', 'm1')
    await pushInboundAndWaitDispatch(server, 'carol@srv', 'm2')

    // Explicit target to alice — must go to alice, not to the cached "carol".
    const sendText = channelPlugin.outbound.sendText as (
      ctx: { to: string; text: string; accountId: string },
    ) => Promise<{ channel: string; messageId: string }>

    await sendText({ to: 'alice@srv', text: 'direct reply to alice', accountId: 'default' })

    await waitFor(() => server.messageRequests.length >= 1)
    const payload = server.messageRequests[0].payload as {
      chatId: string
      content: { text: string }
    }
    expect(payload.chatId).toBe('chat_alice@srv')
    expect(payload.content.text).toBe('direct reply to alice')
  })

  it('skips without redirect when ctx.to is self and no inbound peer was cached yet', async () => {
    harness = await bootPlugin(server)

    const sendText = channelPlugin.outbound.sendText as (
      ctx: { to: string; text: string; accountId: string },
    ) => Promise<{ channel: string; messageId: string }>

    // No inbound has been received yet. Gateway's system-message self-send must be a no-op.
    const reply = await sendText({ to: 'bot@srv', text: 'system notice', accountId: 'default' })
    expect(reply.messageId).toBe('')

    // Give the event loop a beat, then assert no outbound reached the server.
    await new Promise((r) => setTimeout(r, 150))
    expect(server.messageRequests).toHaveLength(0)
  })

  it('sendMedia redirects to last inbound peer when ctx.to equals bot identity', async () => {
    harness = await bootPlugin(server)
    await pushInboundAndWaitDispatch(server, 'alice@srv', 'm1')

    // Prepare a local file for upload.
    const filePath = join(workDir, 'pic.bin')
    await writeFile(filePath, Buffer.from('MEDIA-BYTES-FALLBACK'))

    // Simulate agent tool-call: sendMedia with ctx.to = bot identity (gateway bug).
    const sendMedia = (channelPlugin.outbound as { sendMedia: SendMedia }).sendMedia
    await sendMedia({
      to: 'bot@srv',
      text: 'take a look',
      mediaUrl: pathToFileURL(filePath).toString(),
      mediaLocalRoots: [workDir],
      accountId: 'default',
    })

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)
    const payload = server.sendFileRequests[0].payload as {
      chatId: string
      content: { caption?: { text: string } }
    }
    expect(payload.chatId).toBe('chat_alice@srv')
    expect(payload.content.caption?.text).toBe('take a look')
  })
})
