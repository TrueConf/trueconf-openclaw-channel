import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull, mapPushToResolverEvent } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'
import type { TrueConfFlatConfig } from '../../src/types'

const dispatch = vi.mocked(dispatchInboundDirectDmWithRuntime)
const BOT_ID = 'bot@srv'

interface Harness {
  abort: () => void
  startPromise: Promise<void>
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
}

async function bootPlugin(server: FakeServer, extraConfig: Partial<TrueConfFlatConfig> = {}): Promise<Harness> {
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
          username: BOT_ID,
          password: 'secret',
          ...extraConfig,
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

function groupTextEnvelope(opts: { author: string; text: string; chatId: string; messageId: string }) {
  return {
    type: 200,
    chatId: opts.chatId,
    author: { id: opts.author, type: 1 },
    content: { text: opts.text, parseMode: 'text' as const },
    messageId: opts.messageId,
    timestamp: Date.now(),
  }
}

describe('integration: always-respond — getChatByID adapter contract', () => {
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

  it('treats missing errorCode on getChatByID response as success (server omits errorCode:0)', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.chats.add({ chatId: 'grp_late', title: 'HR', chatType: 2 })
    server.configureFailures({ getChatByIDOmitErrorCode: 1 })
    server.pushEvent('addChatParticipant', { chatId: 'grp_late', userId: BOT_ID })

    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('joined group "hr" — added to always-respond')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_late', messageId: 'omit-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(harness!.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('getChatByID(grp_late) failed'))
  })

  it('treats non-zero errorCode on getChatByID as null and warns will-reconcile', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.chats.add({ chatId: 'grp_fail', title: 'HR', chatType: 2 })
    server.configureFailures({ getChatByID: 1 })
    server.pushEvent('addChatParticipant', { chatId: 'grp_fail', userId: BOT_ID })

    await waitFor(() => harness!.logger.warn.mock.calls.some((c) => String(c[0]).includes('getChatByID(grp_fail) failed for add')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_fail', messageId: 'fail-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('unit: mapPushToResolverEvent — payload validation', () => {
  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }

  it('drops addChatParticipant with missing chatId', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('addChatParticipant', { userId: BOT_ID }, logger)
    expect(ev).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('addChatParticipant'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing chatId'))
  })

  it('drops addChatParticipant with empty chatId', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('addChatParticipant', { chatId: '', userId: BOT_ID }, logger)
    expect(ev).toBeNull()
  })

  it('drops addChatParticipant with non-string chatId', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('addChatParticipant', { chatId: 123, userId: BOT_ID }, logger)
    expect(ev).toBeNull()
  })

  it('drops addChatParticipant with missing userId', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('addChatParticipant', { chatId: 'grp_1' }, logger)
    expect(ev).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing userId'))
  })

  it('drops removeChatParticipant with missing userId', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('removeChatParticipant', { chatId: 'grp_1' }, logger)
    expect(ev).toBeNull()
  })

  it('drops editChatTitle with missing title', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('editChatTitle', { chatId: 'grp_1' }, logger)
    expect(ev).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing title'))
  })

  it('drops createGroupChat with missing chatId', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('createGroupChat', {}, logger)
    expect(ev).toBeNull()
  })

  it('drops removeChat with missing chatId', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('removeChat', {}, logger)
    expect(ev).toBeNull()
  })

  it('returns null for unknown methods (no warn)', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('someUnknownMethod', { chatId: 'grp_1' }, logger)
    expect(ev).toBeNull()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('passes well-formed addChatParticipant', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('addChatParticipant', { chatId: 'grp_1', userId: BOT_ID }, logger)
    expect(ev).toEqual({ kind: 'add', chatId: 'grp_1', userId: BOT_ID })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('passes well-formed editChatTitle', () => {
    const logger = makeLogger()
    const ev = mapPushToResolverEvent('editChatTitle', { chatId: 'grp_1', title: 'New' }, logger)
    expect(ev).toEqual({ kind: 'rename', chatId: 'grp_1', title: 'New' })
  })
})
