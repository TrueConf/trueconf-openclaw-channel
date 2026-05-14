import { describe, it, expect, vi } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('channel.ts caPath plumbing', () => {
  it('loadCaFromAccount returns Buffer when caPath file exists', async () => {
    const { loadCaFromAccount } = await import('../../src/channel')
    const dir = mkdtempSync(join(tmpdir(), 'tc-ca-'))
    const caPath = join(dir, 'ca.pem')
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n')

    const ca = loadCaFromAccount({
      accountId: 'default',
      configured: true,
      enabled: true,
      serverUrl: 'tc.example.com',
      username: 'bot',
      password: 'pw',
      caPath,
    })
    expect(ca).toBeInstanceOf(Buffer)
    expect(ca!.toString('utf8')).toContain('BEGIN CERTIFICATE')
  })

  it('loadCaFromAccount returns undefined when caPath not set', async () => {
    const { loadCaFromAccount } = await import('../../src/channel')
    const ca = loadCaFromAccount({
      accountId: 'default',
      configured: true,
      enabled: true,
      serverUrl: 'tc.example.com',
      username: 'bot',
      password: 'pw',
    })
    expect(ca).toBeUndefined()
  })

  it('loadCaFromAccount throws when caPath set but file does not exist', async () => {
    const { loadCaFromAccount } = await import('../../src/channel')
    expect(() =>
      loadCaFromAccount({
        accountId: 'default',
        configured: true,
        enabled: true,
        serverUrl: 'tc.example.com',
        username: 'bot',
        password: 'pw',
        caPath: '/nonexistent/path/ca.pem',
      }),
    ).toThrow(/trust anchor unreadable.*\/nonexistent\/path\/ca\.pem/)
  })

  it('loadCaFromAccount returns undefined and skips caPath read when tlsVerify=false', async () => {
    const { loadCaFromAccount } = await import('../../src/channel')
    const ca = loadCaFromAccount({
      accountId: 'default',
      configured: true,
      enabled: true,
      serverUrl: 'tc.example.com',
      username: 'bot',
      password: 'pw',
      caPath: '/nonexistent/path/ca.pem',
      tlsVerify: false,
    })
    expect(ca).toBeUndefined()
  })
})

describe('shutdownAccountEntry', () => {
  it('calls wsClient.close() and dispatcher.close()', async () => {
    const { shutdownAccountEntry } = await import('../../src/channel')
    const wsClose = vi.fn().mockResolvedValue(undefined)
    const dispClose = vi.fn().mockResolvedValue(undefined)
    const entry = {
      wsClient: { close: wsClose } as never,
      dispatcher: { close: dispClose } as never,
    }
    shutdownAccountEntry(entry)
    expect(wsClose).toHaveBeenCalledOnce()
    expect(dispClose).toHaveBeenCalledOnce()
  })

  it('calls wsClient.close() only when dispatcher is absent', async () => {
    const { shutdownAccountEntry } = await import('../../src/channel')
    const wsClose = vi.fn().mockResolvedValue(undefined)
    const entry = {
      wsClient: { close: wsClose } as never,
    }
    shutdownAccountEntry(entry)
    expect(wsClose).toHaveBeenCalledOnce()
  })

  it('swallows dispatcher.close() rejections (best-effort)', async () => {
    const { shutdownAccountEntry } = await import('../../src/channel')
    const wsClose = vi.fn().mockResolvedValue(undefined)
    const dispClose = vi.fn().mockRejectedValue(new Error('boom'))
    const entry = {
      wsClient: { close: wsClose } as never,
      dispatcher: { close: dispClose } as never,
    }
    // Must not throw, even with the rejected promise pending.
    expect(() => shutdownAccountEntry(entry)).not.toThrow()
    // Let the microtask queue drain so the .catch() is reached.
    await new Promise<void>((r) => setImmediate(r))
    expect(dispClose).toHaveBeenCalledOnce()
  })
})

describe('invalidateChatState', () => {
  it('clears all 5 store maps for the given (accountId, chatId)', async () => {
    const { createRuntimeStore, invalidateChatState } = await import('../../src/channel')
    const store = createRuntimeStore()

    const accountId = 'acct-1'
    const chatId = 'chat-X'

    store.directChatsByStableUserId.set(`${accountId}\u0000user-A`, chatId)
    store.directChatsByStableUserId.set(`${accountId}\u0000user-B`, chatId)
    store.lastInboundRouteByAccount.set(accountId, { kind: 'group', chatId })
    store.chatTypeByChatId.set(chatId, 'group')
    store.inflightChatTypeLookups.set(chatId, Promise.resolve('group'))
    store.recentBotMsgIdsByChat.set(chatId, new Set(['m1', 'm2']))

    invalidateChatState(store, accountId, chatId)

    expect(store.directChatsByStableUserId.has(`${accountId}\u0000user-A`)).toBe(false)
    expect(store.directChatsByStableUserId.has(`${accountId}\u0000user-B`)).toBe(false)
    expect(store.lastInboundRouteByAccount.has(accountId)).toBe(false)
    expect(store.chatTypeByChatId.has(chatId)).toBe(false)
    expect(store.inflightChatTypeLookups.has(chatId)).toBe(false)
    expect(store.recentBotMsgIdsByChat.has(chatId)).toBe(false)
  })

  it('does not touch other accounts or chats', async () => {
    const { createRuntimeStore, invalidateChatState } = await import('../../src/channel')
    const store = createRuntimeStore()

    const accountA = 'acct-A'
    const accountB = 'acct-B'
    const chatX = 'chat-X'
    const chatY = 'chat-Y'

    // Account A has chatX (target of invalidate). Account B has its own chatY.
    store.directChatsByStableUserId.set(`${accountA}\u0000user-1`, chatX)
    store.directChatsByStableUserId.set(`${accountB}\u0000user-1`, chatY)
    // Same userId across accounts — accountA's mapping points at chatX, accountB's at chatY.
    store.lastInboundRouteByAccount.set(accountA, { kind: 'group', chatId: chatX })
    store.lastInboundRouteByAccount.set(accountB, { kind: 'direct', userId: 'user-2' })
    store.chatTypeByChatId.set(chatX, 'group')
    store.chatTypeByChatId.set(chatY, 'p2p')
    store.recentBotMsgIdsByChat.set(chatX, new Set(['m1']))
    store.recentBotMsgIdsByChat.set(chatY, new Set(['m2']))

    invalidateChatState(store, accountA, chatX)

    // Account A's chatX entries cleared.
    expect(store.directChatsByStableUserId.has(`${accountA}\u0000user-1`)).toBe(false)
    expect(store.lastInboundRouteByAccount.has(accountA)).toBe(false)
    // Account B intact.
    expect(store.directChatsByStableUserId.get(`${accountB}\u0000user-1`)).toBe(chatY)
    expect(store.lastInboundRouteByAccount.get(accountB)).toEqual({ kind: 'direct', userId: 'user-2' })
    // chatY-keyed entries intact.
    expect(store.chatTypeByChatId.get(chatY)).toBe('p2p')
    expect(store.recentBotMsgIdsByChat.get(chatY)).toBeDefined()
  })

  it('keeps lastInboundRouteByAccount when route.chatId differs from the invalidated chatId', async () => {
    const { createRuntimeStore, invalidateChatState } = await import('../../src/channel')
    const store = createRuntimeStore()

    const accountId = 'acct-1'
    const chatToInvalidate = 'chat-removed'
    const chatActive = 'chat-active'

    store.lastInboundRouteByAccount.set(accountId, { kind: 'group', chatId: chatActive })
    store.chatTypeByChatId.set(chatToInvalidate, 'group')

    invalidateChatState(store, accountId, chatToInvalidate)

    // Route is keyed by accountId but values reference a different chatId — keep it.
    expect(store.lastInboundRouteByAccount.get(accountId)).toEqual({ kind: 'group', chatId: chatActive })
    expect(store.chatTypeByChatId.has(chatToInvalidate)).toBe(false)
  })
})

describe('SDK push handler wire-up', () => {
  it('invokes invalidateChatState when removeChat push event arrives via wsClient.onPush', async () => {
    const { createRuntimeStore, registerSdkPushHandler } = await import('../../src/channel')
    const { FileUploadLimits } = await import('../../src/limits')

    const store = createRuntimeStore()
    const accountId = 'acct-1'
    const chatId = 'chat-X'
    store.chatTypeByChatId.set(chatId, 'group')
    store.recentBotMsgIdsByChat.set(chatId, new Set(['m1']))

    let captured: ((method: string, payload: Record<string, unknown>) => void) | null = null
    const fakeWsClient = {
      onPush: (listener: (method: string, payload: Record<string, unknown>) => void) => {
        captured = listener
        return () => { captured = null }
      },
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const limits = new FileUploadLimits(50_000_000, logger as never)

    const unsubscribe = registerSdkPushHandler({
      wsClient: fakeWsClient as never,
      store,
      accountId,
      limits,
      logger: logger as never,
    })
    expect(captured).not.toBeNull()

    captured!('removeChat', { chatId })

    expect(store.chatTypeByChatId.has(chatId)).toBe(false)
    expect(store.recentBotMsgIdsByChat.has(chatId)).toBe(false)

    unsubscribe()
  })
})

describe('startAccount onTerminal → outboundQueue.failAll wiring', () => {
  it('forwards terminal kind to outboundQueue.failAll when handle fires onTerminal', async () => {
    vi.resetModules()

    type OnTerminalCb = (terminal: { kind: string }) => void
    const captured: { onTerminal: OnTerminalCb | null } = { onTerminal: null }
    const failAllSpy = vi.fn()
    const outboundQueueSpy = { submit: vi.fn(), failAll: failAllSpy }

    vi.doMock('../../src/ws-worker-handle', async () => {
      const actual = await vi.importActual<typeof import('../../src/ws-worker-handle')>('../../src/ws-worker-handle')
      class FakeHandle {
        botUserId: string | null = null
        onInboundMessage: unknown = null
        // The contract under test: channel.ts assigns handle.onTerminal.
        // Capture every assignment so the test can fire it later.
        _onTerminal: OnTerminalCb | null = null
        get onTerminal(): OnTerminalCb | null { return this._onTerminal }
        set onTerminal(v: OnTerminalCb | null) {
          this._onTerminal = v
          captured.onTerminal = v
        }
        onState: unknown = null
        constructor(_opts: unknown) {}
        onAuth(_l: (id: string) => void): () => void { return () => {} }
        onAuthLost(_l: (r?: string) => void): () => void { return () => {} }
        onPush(_l: unknown): () => void { return () => {} }
        async sendRequest(): Promise<never> { throw new Error('not used in this test') }
        onFileProgress(_id: string, _h: (p: number) => void): void {}
        offFileProgress(_id: string): void {}
        async start(): Promise<void> { /* never resolve so startAccount stays parked */ }
        async close(): Promise<void> {}
        async forceReconnect(): Promise<void> {}
      }
      return {
        ...actual,
        WsWorkerHandle: FakeHandle,
      }
    })

    vi.doMock('../../src/outbound-queue', async () => {
      const actual = await vi.importActual<typeof import('../../src/outbound-queue')>('../../src/outbound-queue')
      class FakeQueue {
        submit = outboundQueueSpy.submit
        failAll = outboundQueueSpy.failAll
      }
      return { ...actual, OutboundQueue: FakeQueue }
    })

    vi.doMock('openclaw/plugin-sdk/channel-inbound', () => ({
      dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
    }))

    const { channelPlugin, registerFull, __resetForTesting } = await import('../../src/channel')
    __resetForTesting()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const api = {
      logger,
      runtime: {},
      config: {
        channels: {
          trueconf: {
            serverUrl: 'tc.example.com',
            port: 4309,
            useTls: false,
            username: 'bot',
            password: 'p',
            dmPolicy: 'open',
          },
        },
      },
      on: () => {},
    }
    registerFull(api as never)
    const ac = new AbortController()
    void (channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>)({
      accountId: 'default',
      setStatus: () => {},
      abortSignal: ac.signal,
    })
    // startAccount registers handlers synchronously in its prelude before
    // awaiting wsClient.start. One microtask flush is enough to land them.
    await new Promise((r) => setTimeout(r, 0))

    expect(captured.onTerminal).not.toBeNull()

    captured.onTerminal!({ kind: 'dns_exhausted' })

    expect(failAllSpy).toHaveBeenCalledTimes(1)
    const err = failAllSpy.mock.calls[0][0] as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/dns_exhausted/)

    ac.abort()
    vi.doUnmock('../../src/ws-worker-handle')
    vi.doUnmock('../../src/outbound-queue')
    vi.doUnmock('openclaw/plugin-sdk/channel-inbound')
    vi.resetModules()
  })
})
