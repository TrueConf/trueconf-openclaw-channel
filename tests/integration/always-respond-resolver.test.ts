import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'
import type { TrueConfFlatConfig } from '../../src/types'

const dispatch = vi.mocked(dispatchInboundDirectDmWithRuntime)

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
          username: 'bot@srv',
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

describe('integration: always-respond resolver — startup enumerate', () => {
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

  // B.7 — single matching title resolves on startup
  it('startup enumerate activates bypass for a matching title', async () => {
    server.chats.set([{ chatId: 'grp_hr_1', title: 'HR', chatType: 2 }])
    server.setChatType('grp_hr_1', 2)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_hr_1', messageId: 'b7-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // B.8 — pagination across 2 pages
  it('paginates getChats and resolves a title on a later page', async () => {
    const list = Array.from({ length: 150 }, (_, i) => ({
      chatId: `grp_${i}`,
      title: i === 120 ? 'HR' : `chat_${i}`,
      chatType: 2 as const,
    }))
    server.chats.set(list)
    server.setChatType('grp_120', 2)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_120', messageId: 'b8-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // B.9 — duplicate title matches multiple groups + warn
  it('warns when one configured title matches multiple groups; applies to all', async () => {
    server.chats.set([
      { chatId: 'grp_a', title: 'HR', chatType: 2 },
      { chatId: 'grp_b', title: 'hr', chatType: 2 },
    ])
    server.setChatType('grp_a', 2)
    server.setChatType('grp_b', 2)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    expect(harness!.logger.warn).toHaveBeenCalledWith(expect.stringContaining('matches 2 chats'))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_a', messageId: 'b9-1' }))
    server.pushInbound(groupTextEnvelope({ author: 'bob@srv', text: 'no mention', chatId: 'grp_b', messageId: 'b9-2' }))
    await waitFor(() => dispatch.mock.calls.length >= 2, 3000)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  // B.10 — title not present in registry; info log; no bypass
  it('logs "not found now" when configured title has no matches; gate still drops', async () => {
    server.chats.set([{ chatId: 'grp_other', title: 'Other', chatType: 2 }])
    server.setChatType('grp_other', 2)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    expect(harness!.logger.info).toHaveBeenCalledWith(expect.stringContaining('"hr" not found now'))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_other', messageId: 'b10-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })

  // B.11 — channel (chatType=6) with matching title is filtered out at enumerate
  it('does not resolve title for channel chats (chatType=6)', async () => {
    server.chats.set([{ chatId: 'ch_hr', title: 'HR', chatType: 6 }])
    server.setChatType('ch_hr', 6)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    expect(harness!.logger.info).toHaveBeenCalledWith(expect.stringContaining('"hr" not found now'))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'whatever', chatId: 'ch_hr', messageId: 'b11-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })

  // C.12 — first page fails once, retry succeeds
  it('retries getChats on transient failure; second attempt succeeds', async () => {
    server.chats.set([{ chatId: 'grp_hr_1', title: 'HR', chatType: 2 }])
    server.setChatType('grp_hr_1', 2)
    server.configureFailures({ getChats: 1 })
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')), 6000)
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_hr_1', messageId: 'c12-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // C.13 — all 3 attempts fail; configuredChatIds still active; titles inactive
  it('all retries fail: configuredChatIds still active, title entries inactive', async () => {
    server.chats.set([{ chatId: 'grp_direct', title: 'AnyTitle', chatType: 2 }, { chatId: 'grp_hr', title: 'HR', chatType: 2 }])
    server.setChatType('grp_direct', 2)
    server.setChatType('grp_hr', 2)
    server.configureFailures({ getChats: 99 })
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR', 'chatId:grp_direct'] })
    await waitFor(() => harness!.logger.warn.mock.calls.some((c) => String(c[0]).includes('getChats failed after 3 attempts')), 10000)

    // configured chatId works
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_direct', messageId: 'c13-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)

    // title-only entry has no resolved chats — push into grp_hr without mention drops
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_hr', messageId: 'c13-2' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // C.14 — partial: after all-failed startup, title is not active (full reconnect re-run is Part 4)
  it('rebuildFromWire re-run after failure activates title bypass', async () => {
    server.chats.set([{ chatId: 'grp_hr_1', title: 'HR', chatType: 2 }])
    server.setChatType('grp_hr_1', 2)
    server.configureFailures({ getChats: 99 })
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.warn.mock.calls.some((c) => String(c[0]).includes('getChats failed after 3 attempts')), 10000)

    // before: title not active — message without mention is dropped
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_hr_1', messageId: 'c14-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()

    // Full reconnect re-run validated in Part 4 (F.23–F.26).
  })

  // G.27 — enumerate completes and bypass is active for the resolved title
  it('startup enumerate completes and emits ready log when title-resolved', async () => {
    server.chats.set([{ chatId: 'grp_hr_1', title: 'HR', chatType: 2 }])
    server.setChatType('grp_hr_1', 2)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    // Bypass should be active for the resolved title
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_hr_1', messageId: 'g27-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // L1 — ready log records counts
  it('emits ready log with correct counts', async () => {
    server.chats.set([
      { chatId: 'grp_a', title: 'HR', chatType: 2 },
      { chatId: 'grp_b', title: 'Devops', chatType: 2 },
    ])
    server.setChatType('grp_a', 2)
    server.setChatType('grp_b', 2)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR', 'chatId:explicit_id'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    const readyLog = harness!.logger.info.mock.calls.find((c) => String(c[0]).includes('always-respond: ready'))
    expect(String(readyLog?.[0])).toMatch(/1 direct chatIds/)
    expect(String(readyLog?.[0])).toMatch(/1 title-resolved/)
  })

  // L2 — configuredChatId not in groups list logs info
  it('logs when configured chatId is not in any group bot is in', async () => {
    server.chats.set([{ chatId: 'grp_a', title: 'Other', chatType: 2 }])
    server.setChatType('grp_a', 2)
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['chatId:not_in_list'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    expect(harness!.logger.info).toHaveBeenCalledWith(expect.stringContaining('configured chatId not_in_list not a group'))
  })
})
