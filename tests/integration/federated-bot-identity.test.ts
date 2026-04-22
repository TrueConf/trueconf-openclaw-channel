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

// Federation scenario: TrueConf's auth response returns the bot's JID with an
// instance resource suffix (e.g. `bot@srv/fe572107`). That value propagates
// into ctxPayload.To and, via the SDK's tools.message plumbing, becomes the
// agent's inferred `target` when the LLM doesn't pass an explicit one. The
// OpenClaw SDK target resolver rejects unrecognized ids with `Unknown target`
// before reaching our outbound plugin, so the existing self-send redirect
// never fires. Two defenses tested here:
//   1. recipientAddress passed to dispatch is the BARE bot JID, so ctx.To /
//      currentChannelId don't leak the per-connection resource into sessions.
//   2. sendMedia still redirects to the cached inbound peer when the SDK
//      delivers the bare bot JID to our plugin after its own normalization.
describe('integration: federated bot identity (resource in userId)', () => {
  let server: FakeServer
  let harness: Harness | null = null
  let workDir: string

  beforeEach(async () => {
    __resetForTesting()
    dispatch.mockClear()
    server = await startFakeServer({ botUserId: 'bot@srv/fe572107' })
    workDir = await mkdtemp(join(tmpdir(), 'tc-fed-'))
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

  it('dispatch receives bare bot JID as recipientAddress (no /resource leak)', async () => {
    harness = await bootPlugin(server)
    await pushInboundAndWaitDispatch(server, 'alice@srv', 'm1')

    const callArg = dispatch.mock.calls[0]![0] as { recipientAddress: string }
    expect(callArg.recipientAddress).toBe('bot@srv')
  })

  it('sendMedia redirects to last inbound peer when ctx.to is the bare bot JID and botUserId carries a resource', async () => {
    harness = await bootPlugin(server)
    await pushInboundAndWaitDispatch(server, 'alice@srv', 'm1')

    const filePath = join(workDir, 'pic.bin')
    await writeFile(filePath, Buffer.from('MEDIA-BYTES-FEDERATED'))

    const sendMedia = (channelPlugin.outbound as { sendMedia: SendMedia }).sendMedia
    await sendMedia({
      to: 'bot@srv',
      text: 'look',
      mediaUrl: pathToFileURL(filePath).toString(),
      mediaLocalRoots: [workDir],
      accountId: 'default',
    })

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)
    const payload = server.sendFileRequests[0]!.payload as {
      chatId: string
      content: { caption?: { text: string } }
    }
    expect(payload.chatId).toBe('chat_alice@srv')
    expect(payload.content.caption?.text).toBe('look')
  })
})
