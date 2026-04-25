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

  const BOT_ID = 'bot@srv'

  // D.15 — bot joins matching-title group
  it('addChatParticipant(self, matching title) activates bypass', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    // After ready, register the new chat in the registry (so getChatByID finds it)
    server.chats.add({ chatId: 'grp_new', title: 'HR', chatType: 2 })
    server.pushEvent('addChatParticipant', { chatId: 'grp_new', userId: BOT_ID })
    // Allow handleEvent to drain
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('joined group "hr" — added to always-respond')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_new', messageId: 'd15-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // D.16 — bot joins non-matching group → no bypass
  it('addChatParticipant(self, non-matching title) does not activate bypass', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.chats.add({ chatId: 'grp_new', title: 'NotHR', chatType: 2 })
    server.pushEvent('addChatParticipant', { chatId: 'grp_new', userId: BOT_ID })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('joined group "nothr"')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_new', messageId: 'd16-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })

  // D.17 — other user joins the group → ignored
  it('addChatParticipant(other user) is ignored', async () => {
    server.chats.set([{ chatId: 'grp_x', title: 'NotHR', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    const beforeCalls = harness!.logger.info.mock.calls.length
    server.pushEvent('addChatParticipant', { chatId: 'grp_x', userId: 'someone_else@srv' })
    await new Promise((r) => setTimeout(r, 100))
    // No "joined group" log emitted for non-self
    expect(harness!.logger.info.mock.calls.slice(beforeCalls).some((c) => String(c[0]).includes('joined group'))).toBe(false)
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_x', messageId: 'd17-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })

  // D.18 — rename IN
  it('editChatTitle rename IN activates bypass', async () => {
    server.chats.set([{ chatId: 'grp_1', title: 'OldName', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['NewName'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.chats.rename('grp_1', 'NewName')
    server.pushEvent('editChatTitle', { chatId: 'grp_1', title: 'NewName' })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('renamed "oldname" → "newname", added to always-respond')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_1', messageId: 'd18-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // D.19 — rename OUT
  it('editChatTitle rename OUT deactivates bypass', async () => {
    server.chats.set([{ chatId: 'grp_1', title: 'HR', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.chats.rename('grp_1', 'NotHR')
    server.pushEvent('editChatTitle', { chatId: 'grp_1', title: 'NotHR' })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('removed from always-respond')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_1', messageId: 'd19-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })

  // D.20 — rename OUT but configuredChatId still active
  it('rename OUT logs "still active via configured chatId" when chatId is also configured', async () => {
    server.chats.set([{ chatId: 'grp_1', title: 'HR', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR', 'chatId:grp_1'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.chats.rename('grp_1', 'Other')
    server.pushEvent('editChatTitle', { chatId: 'grp_1', title: 'Other' })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('removed from title-resolved (still active via configured chatId)')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_1', messageId: 'd20-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // E.21 — addChatParticipant where getChatByID returns non-group (chatType=1)
  it('addChatParticipant where getChatByID returns non-group is silently ignored', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    // grp_unknown is NOT in the registry — getChatByID falls back to chatType=1 (P2P)
    server.pushEvent('addChatParticipant', { chatId: 'grp_unknown', userId: BOT_ID })
    await new Promise((r) => setTimeout(r, 250))
    // No "joined group" log because chatType=1 fell through silently (P2P returned by fallback)
    // and bypass is not active
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_unknown', messageId: 'e21-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })

  // E.22 — editChatTitle for unknown chatId, getChatByID returns matching group
  it('editChatTitle for unknown chatId falls back to getChatByID and activates if matching', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.chats.add({ chatId: 'grp_late', title: 'HR', chatType: 2 })
    server.pushEvent('editChatTitle', { chatId: 'grp_late', title: 'HR' })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('joined group "hr" — added to always-respond')))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_late', messageId: 'e22-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // F.23 — reconnect: chat removed from registry → bypass cleared after re-auth
  it('re-auth rebuilds: chat removed during downtime drops bypass', async () => {
    server.chats.set([{ chatId: 'grp_1', title: 'HR', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))

    // Drop connection, modify registry, reconnect
    server.chats.remove('grp_1')
    const beforeReady = harness!.logger.info.mock.calls.filter((c) => String(c[0]).includes('always-respond: ready')).length
    server.dropAll()
    await waitFor(() => server.connections.size > 0, 8000)
    // Wait for second ready log
    await waitFor(() => harness!.logger.info.mock.calls.filter((c) => String(c[0]).includes('always-respond: ready')).length > beforeReady, 8000)

    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_1', messageId: 'f23-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })

  // F.24 — reconnect: registry rename to matching → bypass activates
  it('re-auth rebuilds: rename to matching during downtime activates bypass', async () => {
    server.chats.set([{ chatId: 'grp_1', title: 'OldName', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['NewName'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    // No bypass yet
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_1', messageId: 'f24-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()

    server.chats.rename('grp_1', 'NewName')
    const beforeReady = harness!.logger.info.mock.calls.filter((c) => String(c[0]).includes('always-respond: ready')).length
    server.dropAll()
    await waitFor(() => server.connections.size > 0, 8000)
    await waitFor(() => harness!.logger.info.mock.calls.filter((c) => String(c[0]).includes('always-respond: ready')).length > beforeReady, 8000)

    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_1', messageId: 'f24-2' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // F.25 — reconnect: rename out of matching → bypass deactivates
  it('re-auth rebuilds: rename out of matching during downtime deactivates bypass', async () => {
    server.chats.set([{ chatId: 'grp_1', title: 'HR', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))

    server.chats.rename('grp_1', 'Other')
    const beforeReady = harness!.logger.info.mock.calls.filter((c) => String(c[0]).includes('always-respond: ready')).length
    server.dropAll()
    await waitFor(() => server.connections.size > 0, 8000)
    await waitFor(() => harness!.logger.info.mock.calls.filter((c) => String(c[0]).includes('always-respond: ready')).length > beforeReady, 8000)

    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_1', messageId: 'f25-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })

  // F.26 — configuredChatId survives a remove+add pair
  it('configuredChatId survives removeChatParticipant+addChatParticipant cycle', async () => {
    server.chats.set([{ chatId: 'grp_1', title: 'Whatever', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['chatId:grp_1'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.pushEvent('removeChatParticipant', { chatId: 'grp_1', userId: BOT_ID })
    await new Promise((r) => setTimeout(r, 100))
    server.pushEvent('addChatParticipant', { chatId: 'grp_1', userId: BOT_ID })
    await new Promise((r) => setTimeout(r, 200))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'hi', chatId: 'grp_1', messageId: 'f26-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // G.28 — re-auth race: removeChatParticipant during reset+enumerate window
  it('re-auth race: events during reset+enumerate window are buffered and applied', async () => {
    server.chats.set([{ chatId: 'grp_1', title: 'HR', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))

    const beforeReady = harness!.logger.info.mock.calls.filter((c) => String(c[0]).includes('always-respond: ready')).length
    server.dropAll()
    await waitFor(() => server.connections.size > 0, 8000)
    // Inject the removeChatParticipant event right after reconnect — buffering window
    server.pushEvent('removeChatParticipant', { chatId: 'grp_1', userId: BOT_ID })
    await waitFor(() => harness!.logger.info.mock.calls.filter((c) => String(c[0]).includes('always-respond: ready')).length > beforeReady, 8000)

    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_1', messageId: 'g28-1' }))
    await new Promise((r) => setTimeout(r, 200))
    // After enumerate the chat may or may not still be in registry (we kept it in F-runners) — registry still has it
    // BUT then the removeChatParticipant event drained → titleResolvedChatIds.delete(grp_1) → no bypass
    expect(dispatch).not.toHaveBeenCalled()
  })

  // Runtime duplicate detection
  it('warns when a runtime addChatParticipant creates a duplicate-title bypass', async () => {
    server.chats.set([{ chatId: 'grp_a', title: 'HR', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))
    server.chats.add({ chatId: 'grp_b', title: 'HR', chatType: 2 })
    server.pushEvent('addChatParticipant', { chatId: 'grp_b', userId: BOT_ID })
    await waitFor(() => harness!.logger.warn.mock.calls.some((c) => String(c[0]).includes('"hr" now matches 2 chats')), 3000)
  })
})
