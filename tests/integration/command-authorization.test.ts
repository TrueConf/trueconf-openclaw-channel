import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrueConfFlatConfig } from '../../src/types'

vi.mock('openclaw/plugin-sdk/channel-inbound', async () =>
  (await import('./__helpers__/channel-inbound-mock')).channelInboundMock())

import { dispatchChannelInboundTurn, dispatchInboundDirectDm } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'
import type { GroupTurn } from './__helpers__/channel-inbound-mock'

const dispatch = vi.mocked(dispatchInboundDirectDm)
const groupDispatch = vi.mocked(dispatchChannelInboundTurn)

interface Harness {
  abort: () => void
  startPromise: Promise<void>
}

async function bootPlugin(server: FakeServer, extraConfig: Partial<TrueConfFlatConfig> = {}): Promise<Harness> {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const api = {
    logger,
    runtime: {
      channel: { commands: { isControlCommandMessage: (text: string) => text.startsWith('/') } },
    },
    config: {
      channels: {
        trueconf: {
          serverUrl: server.serverUrl,
          port: server.port,
          useTls: false,
          username: 'bot@srv',
          password: 'secret',
          ...extraConfig,
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

const GROUP_CHAT = 'group_123'

function envelope(opts: { author: string; text: string; messageId: string; chatId?: string }) {
  return {
    type: 200,
    chatId: opts.chatId ?? `chat_${opts.author}`,
    author: { id: opts.author, type: 1 },
    content: { text: opts.text, parseMode: 'plain' },
    messageId: opts.messageId,
    timestamp: Date.now(),
  }
}

type DispatchArg = { senderId: string; commandBody?: string; commandAuthorized?: boolean }

async function dispatchedFor(count: number): Promise<DispatchArg[]> {
  await waitFor(() => dispatch.mock.calls.length >= count, 3000)
  await new Promise((r) => setTimeout(r, 150))
  return dispatch.mock.calls.map((call) => call[0] as DispatchArg)
}

describe('integration: control command authorization', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    dispatch.mockClear()
    groupDispatch.mockClear()
    server = await startFakeServer()
    server.setChatType(GROUP_CHAT, 2)
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
  })

  it('open DMs without allowFrom: the command reaches OpenClaw unauthorized', async () => {
    harness = await bootPlugin(server, { dmPolicy: 'open' })

    server.pushInbound(envelope({ author: 'alice@srv', text: '/reset', messageId: 'm1' }))

    const [arg] = await dispatchedFor(1)
    expect(arg).toMatchObject({ senderId: 'alice@srv', commandBody: '/reset', commandAuthorized: false })
  })

  it('authorizes only senders listed in allowFrom', async () => {
    harness = await bootPlugin(server, { dmPolicy: 'open', allowFrom: ['bob@srv'] })

    server.pushInbound(envelope({ author: 'alice@srv', text: '/reset', messageId: 'm2' }))
    server.pushInbound(envelope({ author: 'bob@srv', text: '/reset', messageId: 'm3' }))

    const args = await dispatchedFor(2)
    expect(args.find((a) => a.senderId === 'alice@srv')?.commandAuthorized).toBe(false)
    expect(args.find((a) => a.senderId === 'bob@srv')?.commandAuthorized).toBe(true)
  })

  it('"*" in allowFrom authorizes every sender', async () => {
    harness = await bootPlugin(server, { dmPolicy: 'open', allowFrom: ['*'] })

    server.pushInbound(envelope({ author: 'alice@srv', text: '/reset', messageId: 'm4' }))

    const [arg] = await dispatchedFor(1)
    expect(arg.commandAuthorized).toBe(true)
  })

  it('in a group, only members listed in allowFrom run commands', async () => {
    harness = await bootPlugin(server, {
      allowFrom: ['bob@srv'],
      groupAlwaysRespondIn: [`chatId:${GROUP_CHAT}`],
    })

    server.pushInbound(envelope({ author: 'alice@srv', text: '/reset', messageId: 'g1', chatId: GROUP_CHAT }))
    server.pushInbound(envelope({ author: 'bob@srv', text: '/reset', messageId: 'g2', chatId: GROUP_CHAT }))

    await waitFor(() => groupDispatch.mock.calls.length >= 2, 3000)
    const ctxs = groupDispatch.mock.calls.map((call) => (call[0] as unknown as GroupTurn).ctxPayload)
    const bySender = (id: string) => ctxs.find((c) => c.sender.id === id)
    expect(bySender('alice@srv')).toMatchObject({
      message: { commandBody: '/reset' },
      access: { commands: { authorized: false } },
    })
    expect(bySender('bob@srv')).toMatchObject({
      message: { commandBody: '/reset' },
      access: { commands: { authorized: true } },
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('plain text carries no command fields', async () => {
    harness = await bootPlugin(server, { allowFrom: ['*'] })

    server.pushInbound(envelope({ author: 'alice@srv', text: 'hello', messageId: 'm5' }))

    const [arg] = await dispatchedFor(1)
    expect(arg.commandBody).toBeUndefined()
    expect(arg.commandAuthorized).toBeUndefined()
  })
})
