import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

vi.mock('openclaw/plugin-sdk/channel-inbound', async () =>
  (await import('./__helpers__/channel-inbound-mock')).channelInboundMock())

import { dispatchChannelInboundTurn, dispatchInboundDirectDm } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

const dmDispatch = vi.mocked(dispatchInboundDirectDm)
const groupDispatch = vi.mocked(dispatchChannelInboundTurn)

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
    registerTool: () => {},
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

const GROUP_CHAT = 'group_xyz'
const ALICE = 'alice@srv'
const BOB = 'bob@srv'

function groupMention(opts: { author: string; text: string; messageId: string }) {
  return {
    type: 200,
    chatId: GROUP_CHAT,
    author: { id: opts.author, type: 1 },
    content: { text: `<a href="trueconf:bot@srv">Bot</a> ${opts.text}`, parseMode: 'html' },
    messageId: opts.messageId,
    timestamp: Date.now(),
  }
}

type SendText = (ctx: Record<string, unknown>) => Promise<{ channel: string; messageId: string }>
type SendMedia = (ctx: Record<string, unknown>) => Promise<{ channel: string; messageId: string }>

describe('integration: group-context outbound (tool path)', () => {
  let server: FakeServer
  let harness: Harness | null = null
  let workDir: string

  beforeEach(async () => {
    __resetForTesting()
    dmDispatch.mockClear()
    groupDispatch.mockClear()
    server = await startFakeServer()
    server.setChatType(GROUP_CHAT, 2)
    workDir = await mkdtemp(join(tmpdir(), 'tc-grp-out-'))
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

  it.each(['trueconf:group:grp_target', 'group:grp_target'])('sendText to %s posts into that chat without a P2P chat', async (to) => {
    harness = await bootPlugin(server)

    const sendText = channelPlugin.outbound.sendText as SendText
    const result = await sendText({ to, text: 'to the group', accountId: 'default' })

    expect(result.messageId).toMatch(/^msg_/)
    expect(server.messageRequests.map((r) => r.payload)).toEqual([
      expect.objectContaining({ chatId: 'grp_target', content: expect.objectContaining({ text: 'to the group' }) }),
    ])
    expect(server.createP2PChatRequests).toEqual([])
  })

  it.each(['trueconf:group:grp_target', 'group:grp_target'])('sendMedia to %s posts the file into that chat without a P2P chat', async (to) => {
    harness = await bootPlugin(server)
    const filePath = join(workDir, 'doc.bin')
    await writeFile(filePath, Buffer.from('GROUP-TARGET-BYTES'))

    const sendMedia = (channelPlugin.outbound as { sendMedia: SendMedia }).sendMedia
    const result = await sendMedia({
      to,
      text: 'the file',
      mediaUrl: pathToFileURL(filePath).toString(),
      mediaLocalRoots: [workDir],
      accountId: 'default',
    })

    expect(result.messageId).toMatch(/^fmsg_/)
    expect(server.sendFileRequests.map((r) => r.payload)).toEqual([
      expect.objectContaining({ chatId: 'grp_target', content: expect.objectContaining({ caption: expect.objectContaining({ text: 'the file' }) }) }),
    ])
    expect(server.createP2PChatRequests).toEqual([])
  })

  it('sendText and sendMedia with ctx.to=bot after only a group mention are skipped, not sent to the group', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupMention({ author: ALICE, text: 'ping', messageId: 'g1' }))
    await waitFor(() => groupDispatch.mock.calls.length >= 1)

    const filePath = join(workDir, 'img.bin')
    await writeFile(filePath, Buffer.from('GROUP-MEDIA-BYTES'))
    const sendText = channelPlugin.outbound.sendText as SendText
    const sendMedia = (channelPlugin.outbound as { sendMedia: SendMedia }).sendMedia
    const results = [
      await sendText({ to: 'bot@srv', text: 'not for the group', accountId: 'default' }),
      await sendMedia({
        to: 'bot@srv',
        text: 'not for the group',
        mediaUrl: pathToFileURL(filePath).toString(),
        mediaLocalRoots: [workDir],
        accountId: 'default',
      }),
    ]

    expect(results).toEqual([
      { channel: 'trueconf', messageId: '' },
      { channel: 'trueconf', messageId: '' },
    ])
    expect(server.messageRequests).toEqual([])
    expect(server.sendFileRequests).toEqual([])
    expect(server.createP2PChatRequests).toEqual([])
  })

  it('a DM-run send to the bot JID goes to the last DM peer, also when a group message came after the DM', async () => {
    harness = await bootPlugin(server)

    server.pushInbound({
      type: 200,
      chatId: 'chat_bob@srv',
      author: { id: BOB, type: 1 },
      content: { text: 'hey bot', parseMode: 'text' },
      messageId: 'd1',
      timestamp: Date.now(),
    })
    await waitFor(() => dmDispatch.mock.calls.length >= 1)
    server.pushInbound(groupMention({ author: ALICE, text: 'hi group', messageId: 'g3' }))
    await waitFor(() => groupDispatch.mock.calls.length >= 1)

    const sendText = channelPlugin.outbound.sendText as SendText
    await sendText({ to: 'bot@srv', text: 'reply to bob', accountId: 'default' })

    await waitFor(() => server.messageRequests.length >= 1)
    expect(server.messageRequests.map((r) => r.payload)).toEqual([
      expect.objectContaining({ chatId: 'chat_bob@srv', content: expect.objectContaining({ text: 'reply to bob' }) }),
    ])
  })

  it('after group, explicit ctx.to=<userJid> still routes to that user\'s DM (no group override)', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupMention({ author: ALICE, text: 'ping', messageId: 'g4' }))
    await waitFor(() => groupDispatch.mock.calls.length >= 1)

    // Agent explicitly addresses a specific user — must NOT be rewritten to
    // the group even though the last inbound was a group.
    const sendText = channelPlugin.outbound.sendText as SendText
    await sendText({ to: ALICE, text: 'whisper', accountId: 'default' })

    await waitFor(() => server.messageRequests.length >= 1)
    const payload = server.messageRequests[0].payload as { chatId: string }
    expect(payload.chatId).toBe('chat_alice@srv')
  })
})
