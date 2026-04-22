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
    dispatch.mockClear()
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

  it('sendText with ctx.to=bot after a group mention → routes to group chatId (not P2P DM)', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupMention({ author: ALICE, text: 'ping', messageId: 'g1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1)

    const sendText = channelPlugin.outbound.sendText as SendText
    const result = await sendText({
      to: 'bot@srv',
      text: 'reply in the group',
      accountId: 'default',
    })

    expect(result.channel).toBe('trueconf')
    expect(result.messageId).toMatch(/^msg_/)

    await waitFor(() => server.messageRequests.length >= 1)
    const payload = server.messageRequests[0].payload as {
      chatId: string
      content: { text: string }
    }
    // Before the fix: this would either fail (skipped) or misroute via
    // createP2PChat to the bot identity. After the fix: the last inbound
    // route is the group, so the self-send redirect lands in GROUP_CHAT.
    expect(payload.chatId).toBe(GROUP_CHAT)
    expect(payload.content.text).toBe('reply in the group')
    // No P2P chat should have been created as a side effect.
    const createP2PIdx = server.messageRequests.findIndex((r) => r.method === 'createP2PChat')
    expect(createP2PIdx).toBe(-1)
  })

  it('sendMedia with ctx.to=bot after a group mention → photo lands in group chatId', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupMention({ author: ALICE, text: 'send the photo', messageId: 'g2' }))
    await waitFor(() => dispatch.mock.calls.length >= 1)

    const filePath = join(workDir, 'img.bin')
    await writeFile(filePath, Buffer.from('GROUP-MEDIA-BYTES'))

    const sendMedia = (channelPlugin.outbound as { sendMedia: SendMedia }).sendMedia
    const result = await sendMedia({
      to: 'bot@srv',
      text: 'here you go',
      mediaUrl: pathToFileURL(filePath).toString(),
      mediaLocalRoots: [workDir],
      accountId: 'default',
    })

    expect(result.messageId).toMatch(/^fmsg_/)

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)
    const payload = server.sendFileRequests[0].payload as {
      chatId: string
      content: { caption?: { text: string } }
    }
    // Before the fix: sendMedia called handleOutboundAttachment, which went
    // through resolveDirectChat (creating/reusing P2P with the bot identity).
    // After the fix: group-kind last route dispatches via sendFile with
    // chatId=GROUP_CHAT directly, no createP2PChat invoked for the group.
    expect(payload.chatId).toBe(GROUP_CHAT)
    expect(payload.content.caption?.text).toBe('here you go')
  })

  it('after group THEN DM, sendText self-send redirect follows the DM (most-recent wins)', async () => {
    harness = await bootPlugin(server)

    // Group mention — last route = group
    server.pushInbound(groupMention({ author: ALICE, text: 'hi group', messageId: 'g3' }))
    await waitFor(() => dispatch.mock.calls.length >= 1)

    // Subsequent DM from Bob — last route flips to direct-with-bob
    server.pushInbound({
      type: 200,
      chatId: 'chat_bob@srv',
      author: { id: BOB, type: 1 },
      content: { text: 'hey bot', parseMode: 'text' },
      messageId: 'd1',
      timestamp: Date.now(),
    })
    await waitFor(() => dispatch.mock.calls.length >= 2)

    const sendText = channelPlugin.outbound.sendText as SendText
    await sendText({ to: 'bot@srv', text: 'reply to bob', accountId: 'default' })

    await waitFor(() => server.messageRequests.length >= 1)
    const payload = server.messageRequests[0].payload as {
      chatId: string
      content: { text: string }
    }
    expect(payload.chatId).toBe('chat_bob@srv')
    expect(payload.content.text).toBe('reply to bob')
  })

  it('after group, explicit ctx.to=<userJid> still routes to that user\'s DM (no group override)', async () => {
    harness = await bootPlugin(server)

    server.pushInbound(groupMention({ author: ALICE, text: 'ping', messageId: 'g4' }))
    await waitFor(() => dispatch.mock.calls.length >= 1)

    // Agent explicitly addresses a specific user — must NOT be rewritten to
    // the group even though the last inbound was a group.
    const sendText = channelPlugin.outbound.sendText as SendText
    await sendText({ to: ALICE, text: 'whisper', accountId: 'default' })

    await waitFor(() => server.messageRequests.length >= 1)
    const payload = server.messageRequests[0].payload as { chatId: string }
    expect(payload.chatId).toBe('chat_alice@srv')
  })

  it('sendText with ctx.to=bot and only group history (no DM ever) still routes to the group', async () => {
    harness = await bootPlugin(server)

    // Only a group message, no DM history at all.
    server.pushInbound(groupMention({ author: ALICE, text: 'solo group ping', messageId: 'g5' }))
    await waitFor(() => dispatch.mock.calls.length >= 1)

    const sendText = channelPlugin.outbound.sendText as SendText
    const result = await sendText({ to: 'bot@srv', text: 'group-only reply', accountId: 'default' })

    // Previously: "no cached inbound peer; skipping" because only DM peers
    // were tracked. Now: group route is cached too, so we land in the group.
    expect(result.messageId).toMatch(/^msg_/)
    await waitFor(() => server.messageRequests.length >= 1)
    const payload = server.messageRequests[0].payload as { chatId: string }
    expect(payload.chatId).toBe(GROUP_CHAT)
  })
})
