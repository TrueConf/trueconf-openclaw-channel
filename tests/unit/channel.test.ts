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
  it('calls lifecycle.shutdown() and dispatcher.close()', async () => {
    const { shutdownAccountEntry } = await import('../../src/channel')
    const shutdown = vi.fn()
    const close = vi.fn().mockResolvedValue(undefined)
    const entry = {
      lifecycle: { shutdown } as never,
      wsClient: {} as never,
      dispatcher: { close } as never,
    }
    shutdownAccountEntry(entry)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('calls lifecycle.shutdown() only when dispatcher is absent', async () => {
    const { shutdownAccountEntry } = await import('../../src/channel')
    const shutdown = vi.fn()
    const entry = {
      lifecycle: { shutdown } as never,
      wsClient: {} as never,
    }
    shutdownAccountEntry(entry)
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('swallows dispatcher.close() rejections (best-effort)', async () => {
    const { shutdownAccountEntry } = await import('../../src/channel')
    const shutdown = vi.fn()
    const close = vi.fn().mockRejectedValue(new Error('boom'))
    const entry = {
      lifecycle: { shutdown } as never,
      wsClient: {} as never,
      dispatcher: { close } as never,
    }
    // Must not throw, even with the rejected promise pending.
    expect(() => shutdownAccountEntry(entry)).not.toThrow()
    // Let the microtask queue drain so the .catch() is reached.
    await new Promise<void>((r) => setImmediate(r))
    expect(close).toHaveBeenCalledOnce()
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

describe('forceReconnect injection', () => {
  it('wsClient closure forwards forceReconnect to the lifecycle bound after construction', async () => {
    const { makeForceReconnectAdapter } = await import('../../src/channel')
    const ref: { lifecycle: { forceReconnect: ReturnType<typeof vi.fn> } | null } = { lifecycle: null }
    const closure = makeForceReconnectAdapter(() => ref.lifecycle)

    // Closure used before lifecycle is attached: must not throw, but the call
    // is dropped (lifecycle hasn't been built yet — there is no reconnect path
    // to invoke). Logger-side branch is verified separately by call count.
    await closure('203_credentials_expired_pre_lifecycle')

    const fr = vi.fn(async (_reason: string) => {})
    ref.lifecycle = { forceReconnect: fr }
    await closure('203_credentials_expired')
    expect(fr).toHaveBeenCalledTimes(1)
    expect(fr).toHaveBeenCalledWith('203_credentials_expired')
  })
})

describe('startAccount onTerminalFailure → outboundQueue.failAll wiring', () => {
  it('forwards terminal.cause to outboundQueue.failAll when ConnectionLifecycle fires onTerminalFailure', async () => {
    vi.resetModules()

    type LifecycleOptionsCapture = {
      onTerminalFailure?: (terminal: { kind: string; cause: Error; retries?: number }) => void
    }
    const lifecycleOptions: { value: LifecycleOptionsCapture | null } = { value: null }
    const failAllSpy = vi.fn()
    const outboundQueueSpy = { submit: vi.fn(), failAll: failAllSpy }

    vi.doMock('../../src/ws-client', async () => {
      const actual = await vi.importActual<typeof import('../../src/ws-client')>('../../src/ws-client')
      class FakeLifecycle {
        constructor(_ws: unknown, _cfg: unknown, _logger: unknown, opts: LifecycleOptionsCapture) {
          lifecycleOptions.value = opts
        }
        async start(): Promise<void> { /* never resolve so startAccount stays parked */ }
        shutdown(): void {}
        async forceReconnect(): Promise<void> {}
      }
      class FakeWsClient {
        botUserId: string | null = null
        logger: unknown = null
        ca: Buffer | undefined = undefined
        tlsVerify = true
        onAuth(_l: () => void): () => void { return () => {} }
        onPush(_l: unknown): () => void { return () => {} }
        async sendRequest(): Promise<never> { throw new Error('not used in this test') }
        markAuthenticated(): void {}
        markAuthFailed(_e: Error): void {}
        async waitAuthenticated(): Promise<void> {}
        resetAuthBarrier(): void {}
        close(): void {}
        ping(): void {}
        terminate(): void {}
      }
      return {
        ...actual,
        WsClient: FakeWsClient,
        ConnectionLifecycle: FakeLifecycle,
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
    // awaiting lifecycle.start. One microtask flush is enough to land options.
    await new Promise((r) => setTimeout(r, 0))

    expect(lifecycleOptions.value).not.toBeNull()
    const cb = lifecycleOptions.value?.onTerminalFailure
    expect(cb).toBeTypeOf('function')

    const sentinelCause = new Error('sentinel-terminal-cause')
    cb!({ kind: 'shutdown', cause: sentinelCause })

    expect(failAllSpy).toHaveBeenCalledTimes(1)
    expect(failAllSpy).toHaveBeenCalledWith(sentinelCause)

    ac.abort()
    vi.doUnmock('../../src/ws-client')
    vi.doUnmock('../../src/outbound-queue')
    vi.doUnmock('openclaw/plugin-sdk/channel-inbound')
    vi.resetModules()
  })
})
