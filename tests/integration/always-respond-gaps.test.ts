import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'
import { AlwaysRespondResolver, type WireAdapter } from '../../src/always-respond'
import { parseAlwaysRespondConfig } from '../../src/config'
import type { TrueConfFlatConfig, TrueConfMultiAccountConfig } from '../../src/types'

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

describe('integration: always-respond — extra coverage', () => {
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

  it('skips chatType=1 (P2P), 3 (system), 5 (favorites) at enumerate even with matching title', async () => {
    server.chats.set([
      { chatId: 'p2p_hr', title: 'HR', chatType: 1 },
      { chatId: 'sys_hr', title: 'HR', chatType: 3 },
      { chatId: 'fav_hr', title: 'HR', chatType: 5 },
      { chatId: 'grp_hr', title: 'HR', chatType: 2 },
    ])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))

    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_hr', messageId: 'gap-grp' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)

    const matchedTitleLog = harness!.logger.info.mock.calls.find((c) => String(c[0]).includes('"hr" not found now'))
    expect(matchedTitleLog).toBeUndefined()
    const dupLog = harness!.logger.warn.mock.calls.find((c) => String(c[0]).includes('matches'))
    expect(dupLog).toBeUndefined()
  })

  it('rename → rename-back sequence transitions out then back in', async () => {
    server.chats.set([{ chatId: 'grp_1', title: 'HR', chatType: 2 }])
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))

    server.chats.rename('grp_1', 'NotHR')
    server.pushEvent('editChatTitle', { chatId: 'grp_1', title: 'NotHR' })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('removed from always-respond')))

    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'silent', chatId: 'grp_1', messageId: 'rb-1' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()

    server.chats.rename('grp_1', 'HR')
    server.pushEvent('editChatTitle', { chatId: 'grp_1', title: 'HR' })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('"nothr" → "hr", added to always-respond')))

    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_1', messageId: 'rb-2' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('createGroupChat activates bypass when title matches', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))

    server.chats.add({ chatId: 'grp_new', title: 'HR', chatType: 2 })
    server.pushEvent('createGroupChat', { chatId: 'grp_new' })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('joined group "hr" — added to always-respond')))

    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_new', messageId: 'cg-1' }))
    await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('createGroupChat does not activate bypass for non-group return from getChatByID', async () => {
    harness = await bootPlugin(server, { groupAlwaysRespondIn: ['HR'] })
    await waitFor(() => harness!.logger.info.mock.calls.some((c) => String(c[0]).includes('always-respond: ready')))

    // grp_unknown not in registry — fake-server returns chatType=1 (P2P fallback)
    server.pushEvent('createGroupChat', { chatId: 'grp_unknown' })
    await new Promise((r) => setTimeout(r, 250))
    server.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'silent', chatId: 'grp_unknown', messageId: 'cg-2' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('integration: always-respond — multi-account isolation', () => {
  let serverA: FakeServer
  let serverB: FakeServer

  beforeEach(async () => {
    __resetForTesting()
    dispatch.mockClear()
    serverA = await startFakeServer({ botUserId: 'botA@srv' })
    serverB = await startFakeServer({ botUserId: 'botB@srv' })
  })

  afterEach(async () => {
    await serverA.close()
    await serverB.close()
  })

  it('groupAlwaysRespondIn applies per-account; chats only live on the account that has the bot', async () => {
    serverA.chats.set([{ chatId: 'grp_hr_A', title: 'HR', chatType: 2 }])
    serverB.chats.set([{ chatId: 'grp_hr_B', title: 'Other', chatType: 2 }])

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const cfg: TrueConfMultiAccountConfig = {
      accounts: {
        A: { serverUrl: serverA.serverUrl, port: serverA.port, useTls: false, username: 'botA@srv', password: 'secret' },
        B: { serverUrl: serverB.serverUrl, port: serverB.port, useTls: false, username: 'botB@srv', password: 'secret' },
      },
      groupAlwaysRespondIn: ['HR'],
    }
    registerFull({ logger, runtime: {}, config: { channels: { trueconf: cfg } }, on: () => {} } as never)

    const acA = new AbortController()
    const acB = new AbortController()
    const startA = (channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>)({
      accountId: 'A', setStatus: () => {}, abortSignal: acA.signal,
    })
    const startB = (channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>)({
      accountId: 'B', setStatus: () => {}, abortSignal: acB.signal,
    })
    try {
      await waitFor(() => serverA.connections.size > 0 && serverB.connections.size > 0)
      const readyA = () => logger.info.mock.calls.filter((c) => String(c[0]).includes('always-respond: ready')).length >= 2
      await waitFor(readyA, 5000)

      // A bypasses (HR matches grp_hr_A)
      serverA.pushInbound(groupTextEnvelope({ author: 'alice@srv', text: 'no mention', chatId: 'grp_hr_A', messageId: 'mA-1' }))
      await waitFor(() => dispatch.mock.calls.length >= 1, 3000)
      expect(dispatch).toHaveBeenCalledTimes(1)

      // B does NOT bypass (no matching title on B's chats)
      serverB.pushInbound(groupTextEnvelope({ author: 'bob@srv', text: 'no mention', chatId: 'grp_hr_B', messageId: 'mB-1' }))
      await new Promise((r) => setTimeout(r, 250))
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      acA.abort(); acB.abort()
      await Promise.race([startA.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      await Promise.race([startB.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
    }
  })
})

describe('unit: AlwaysRespondResolver — retry exhaustion and FIFO ordering', () => {
  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }

  it('warns and skips when getChatByID throws on every retry attempt', async () => {
    const logger = makeLogger()
    const wire: WireAdapter = {
      botUserId: BOT_ID,
      getChats: async () => [],
      getChatByID: vi.fn().mockRejectedValue(new Error('transport down')),
    }
    const resolver = new AlwaysRespondResolver(parseAlwaysRespondConfig(['HR'], logger), wire, logger)
    await resolver.rebuildFromWire()

    resolver.enqueueEvent({ kind: 'add', chatId: 'grp_x', userId: BOT_ID })
    await waitFor(() => logger.warn.mock.calls.some((c) => String(c[0]).includes('getChatByID(grp_x) failed for add')))
    expect(wire.getChatByID).toHaveBeenCalledTimes(2)
    expect(resolver.isAlwaysRespond('grp_x')).toBe(false)
  })

  it('does NOT retry when getChatByID returns null (errorCode != 0)', async () => {
    const logger = makeLogger()
    const wire: WireAdapter = {
      botUserId: BOT_ID,
      getChats: async () => [],
      getChatByID: vi.fn().mockResolvedValue(null),
    }
    const resolver = new AlwaysRespondResolver(parseAlwaysRespondConfig(['HR'], logger), wire, logger)
    await resolver.rebuildFromWire()

    resolver.enqueueEvent({ kind: 'add', chatId: 'grp_y', userId: BOT_ID })
    await waitFor(() => logger.warn.mock.calls.some((c) => String(c[0]).includes('getChatByID(grp_y) failed for add')))
    expect(wire.getChatByID).toHaveBeenCalledTimes(1)
  })

  it('drains queued events in FIFO order after rebuildFromWire flips buffering off', async () => {
    const logger = makeLogger()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const callOrder: string[] = []

    const wire: WireAdapter = {
      botUserId: BOT_ID,
      getChats: async () => { await gate; return [] },
      getChatByID: vi.fn().mockImplementation(async (chatId: string) => {
        callOrder.push(chatId)
        return { chatType: 2, title: 'HR' }
      }),
    }
    const resolver = new AlwaysRespondResolver(parseAlwaysRespondConfig(['HR'], logger), wire, logger)

    const rebuildDone = resolver.rebuildFromWire()
    // While rebuildFromWire is awaiting on getChats (blocked by `gate`),
    // events queue up but must NOT drain — buffering=true.
    resolver.enqueueEvent({ kind: 'add', chatId: 'grp_1', userId: BOT_ID })
    resolver.enqueueEvent({ kind: 'add', chatId: 'grp_2', userId: BOT_ID })
    resolver.enqueueEvent({ kind: 'add', chatId: 'grp_3', userId: BOT_ID })

    // Confirm none of the events were processed during the buffering window.
    await new Promise((r) => setTimeout(r, 50))
    expect(callOrder).toEqual([])

    release()
    await rebuildDone
    await waitFor(() => callOrder.length === 3, 3000)
    expect(callOrder).toEqual(['grp_1', 'grp_2', 'grp_3'])
  })

  it('coerces missing `chats` field on getChats response to empty list', async () => {
    // The wireAdapter's getChats already coerces undefined to []. Verify
    // resolver behaves consistently when the snapshot is empty.
    const logger = makeLogger()
    const wire: WireAdapter = {
      botUserId: BOT_ID,
      getChats: async () => [],
      getChatByID: vi.fn(),
    }
    const resolver = new AlwaysRespondResolver(parseAlwaysRespondConfig(['HR'], logger), wire, logger)
    await resolver.rebuildFromWire()
    expect(resolver.isAlwaysRespond('grp_anything')).toBe(false)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"hr" not found now'))
  })

  it('coalesces overlapping rebuildFromWire calls onto a single in-flight promise', async () => {
    const logger = makeLogger()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const getChats = vi.fn().mockImplementation(async () => { await gate; return [] })

    const wire: WireAdapter = {
      botUserId: BOT_ID,
      getChats,
      getChatByID: vi.fn(),
    }
    const resolver = new AlwaysRespondResolver(parseAlwaysRespondConfig(['HR'], logger), wire, logger)

    const first = resolver.rebuildFromWire()
    const second = resolver.rebuildFromWire()
    const third = resolver.rebuildFromWire()

    await new Promise((r) => setTimeout(r, 30))
    expect(getChats).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, second, third])
    expect(getChats).toHaveBeenCalledTimes(1)

    // After the in-flight promise settles, a fresh call paginates again.
    await resolver.rebuildFromWire()
    expect(getChats).toHaveBeenCalledTimes(2)
  })
})
