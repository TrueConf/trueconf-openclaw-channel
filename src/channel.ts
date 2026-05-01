import type { PluginRuntime } from "openclaw/plugin-sdk/core"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store"
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound"
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload"
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle"
import { readFileSync } from 'node:fs'
import { Agent as UndiciAgent, type Dispatcher } from 'undici'
import {
  sendText,
  sendTextToChat,
  sanitizeMarkdown,
  handleOutboundAttachment,
  handleOutboundAttachmentToChat,
  responseErrorCode,
} from './outbound'
import { handleInboundMessage, prepareInboundAttachment, unlinkTempFile, normalizeForCompare, rememberBotMessage, getMaxFileSize, MAX_FILE_SIZE_HARD_LIMIT_BYTES, __resetCoalesceBufferForTesting } from './inbound'
import { FileUploadLimits } from './limits'
import { PerChatSendQueue } from './send-queue'
import { BoundedSeen, handleSdkPushEvent } from './push-events'
import type { InboundContext } from './inbound'
import type { ResolvedChatKind } from './types'
import {
  listAccountIds as listAccountIdsImpl,
  resolveAccount as resolveAccountImpl,
  isConfigured as isConfiguredImpl,
  isEnabled as isEnabledImpl,
  describeAccount as describeAccountImpl,
  shouldAllowMessage,
  parseAlwaysRespondConfig,
} from './config'
import { trueconfSetupWizard } from './channel-setup'
import { trueconfSetupAdapter } from './setup-shared'
import { AlwaysRespondResolver, type WireAdapter, type ResolverEvent } from './always-respond'
import { WsClient, ConnectionLifecycle } from './ws-client'
import { OutboundQueue } from './outbound-queue'
import type { Logger, TrueConfChannelConfig, ResolvedAccount, InboundMessage, InboundExtraContext, InboundMediaContext } from './types'
import { widenExtraContext } from './types'

// Most recent inbound conversation per account. Used only for the self-send
// redirect: when an agent tool call lands with ctx.to == bot's own identity,
// we route it here instead of erroring or hanging on createP2PChat(self).
type InboundRoute =
  | { kind: 'direct'; userId: string }
  | { kind: 'group'; chatId: string }

function getChannelConfig(cfg: unknown): TrueConfChannelConfig {
  return ((cfg as { channels?: { trueconf?: unknown } })?.channels?.trueconf ?? {}) as TrueConfChannelConfig
}

// Reads a CA bundle from account.caPath for custom-TLS TrueConf deployments
// (downloaded by the setup wizard when the server presents an untrusted cert).
// Returns undefined when caPath is absent → caller falls back to system trust.
// Throws when caPath is set but unreadable — failing silent here would
// downgrade pinned trust to the system store without telling the operator.
export function loadCaFromAccount(account: ResolvedAccount): Buffer | undefined {
  // Operator-acknowledged insecure mode: skip the caPath read entirely.
  // tlsVerify=false means "trust nothing, verify nothing" — pinning a CA on
  // top of that would be contradictory and would fail loud here if the file
  // is gone, masking the actual operator intent.
  if (account.tlsVerify === false) return undefined
  if (!account.caPath) return undefined
  try {
    return readFileSync(account.caPath)
  } catch (err) {
    throw new Error(
      `trust anchor unreadable: caPath=${account.caPath} (${(err as Error).message}). ` +
      `Fix permissions / re-run setup to re-TOFU, or remove caPath from config to fall back to system trust.`,
    )
  }
}

export interface AccountEntry {
  lifecycle: ConnectionLifecycle
  wsClient: WsClient
  dispatcher?: Dispatcher
  unsubscribers?: Array<() => void>
  // Per-account state. limits/sendQueue must NOT be channel-wide:
  //  - FileUploadLimits is mutated by per-account `getFileUploadLimits` server
  //    pushes, so different accounts can have different runtime caps.
  //  - PerChatSendQueue serializes outbound per-chatId. ChatIds are unique per
  //    server, so two accounts on different servers must have independent
  //    queues — otherwise unrelated outbounds would block each other.
  limits: FileUploadLimits
  sendQueue: PerChatSendQueue
  outboundQueue: OutboundQueue
}

// Tears down a single account entry: stops its lifecycle and closes the
// undici dispatcher so its keep-alive socket pool releases. Plugin hot-reload
// and rolling restart would otherwise leak sockets per account on every
// redeploy. close() rejections are swallowed — shutdown is best-effort.
export function shutdownAccountEntry(entry: {
  lifecycle: ConnectionLifecycle
  wsClient: WsClient
  dispatcher?: Dispatcher
  unsubscribers?: Array<() => void>
}): void {
  for (const u of entry.unsubscribers ?? []) try { u() } catch { /* ignore */ }
  entry.lifecycle.shutdown()
  entry.dispatcher?.close().catch(() => { /* best-effort */ })
}

function readNonEmptyString(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' && v.length > 0 && !v.includes('\0') ? v : undefined
}

// Reject malformed payloads at the boundary instead of forwarding empty-string
// chatIds into the resolver — those waste two getChatByID round-trips per push
// and emit logs with empty parens that read like a different bug.
export function mapPushToResolverEvent(
  method: string,
  payload: Record<string, unknown>,
  logger: Logger,
): ResolverEvent | null {
  const drop = (reason: string): null => {
    logger.warn(`[trueconf] always-respond: dropping push ${method}: ${reason}`)
    return null
  }
  const chatId = readNonEmptyString(payload, 'chatId')

  switch (method) {
    case 'addChatParticipant': {
      if (!chatId) return drop('missing chatId')
      const userId = readNonEmptyString(payload, 'userId')
      if (!userId) return drop('missing userId')
      return { kind: 'add', chatId, userId }
    }
    case 'removeChatParticipant': {
      if (!chatId) return drop('missing chatId')
      const userId = readNonEmptyString(payload, 'userId')
      if (!userId) return drop('missing userId')
      return { kind: 'remove', chatId, userId }
    }
    case 'createGroupChat':
      if (!chatId) return drop('missing chatId')
      return { kind: 'createGroup', chatId }
    case 'createChannel':
      // Channels never bypass the activation gate; drop without warn.
      return null
    case 'editChatTitle': {
      if (!chatId) return drop('missing chatId')
      const title = readNonEmptyString(payload, 'title')
      if (!title) return drop('missing title')
      return { kind: 'rename', chatId, title }
    }
    case 'removeChat':
      if (!chatId) return drop('missing chatId')
      return { kind: 'removeChat', chatId }
    default:
      return null
  }
}

const pluginRuntimeStore = createPluginRuntimeStore<PluginRuntime>("TrueConf runtime not initialized")

export function createRuntimeStore() {
  return {
    accounts: new Map<string, AccountEntry>(),
    logger: null as Logger | null,
    runtime: null as unknown,
    fullConfig: null as unknown,
    channelConfig: null as TrueConfChannelConfig | null,
    // Registry key: `${accountId}\u0000${stableUserId}`. Updated inline by
    // inbound (on observation) and outbound (on createP2PChat / 304).
    directChatsByStableUserId: new Map<string, string>(),
    // Fallback route when the gateway sets outbound `to` to the bot's own
    // identity (agent tool calls default `to` to ctxPayload.To, which is
    // `recipientAddress` = bot). We redirect to the most recent inbound
    // conversation so replies still land where the user asked. Tracks BOTH
    // direct peers and group chats — without the group case, bot replies
    // to a group @mention get misrouted to a stale DM or silently skipped.
    lastInboundRouteByAccount: new Map<string, InboundRoute>(),
    // chatType is immutable for the lifetime of a chat; survives reconnect.
    chatTypeByChatId: new Map<string, ResolvedChatKind>(),
    // Dedups concurrent getChatByID lookups for the same chatId.
    inflightChatTypeLookups: new Map<string, Promise<ResolvedChatKind>>(),
    // Recent bot messageIds per chat, used for reply-to-bot detection in
    // groups. FIFO-capped per chat, survives reconnect.
    recentBotMsgIdsByChat: new Map<string, Set<string>>(),
  }
}

export type RuntimeStore = ReturnType<typeof createRuntimeStore>

const store = createRuntimeStore()

// Clears all per-(accountId, chatId) cache entries. Called from
// `handleSdkPushEvent('removeChat', ...)`: once the server announces the chat
// is gone, every registry that keys off chatId would otherwise leak entries
// indefinitely (next message in a re-created chat with the same id would
// reuse stale chatType / lastInboundRoute / direct-chat mapping).
export function invalidateChatState(
  store: RuntimeStore,
  accountId: string,
  chatId: string,
): void {
  const accountPrefix = `${accountId}\u0000`
  for (const [key, value] of store.directChatsByStableUserId) {
    if (value === chatId && key.startsWith(accountPrefix)) {
      store.directChatsByStableUserId.delete(key)
    }
  }
  const lastRoute = store.lastInboundRouteByAccount.get(accountId)
  if (lastRoute && lastRoute.kind === 'group' && lastRoute.chatId === chatId) {
    store.lastInboundRouteByAccount.delete(accountId)
  }
  store.chatTypeByChatId.delete(chatId)
  store.inflightChatTypeLookups.delete(chatId)
  store.recentBotMsgIdsByChat.delete(chatId)
}

// Lazy-closure adapter for the WsClient `forceReconnect` option. WsClient is
// constructed BEFORE `lifecycle` exists (chicken-and-egg: lifecycle holds
// wsClient). The closure resolves `lifecycle` at call time via the supplied
// getter, so the binding becomes valid before any 203 response can arrive.
//
// If the closure fires before `lifecycle` is set (truly impossible in practice
// because requests gate on the auth barrier, but defensive), the call is
// dropped — surfacing the original error is preferable to throwing in a code
// path WsClient cannot recover from.
export function makeForceReconnectAdapter(
  getLifecycle: () => { forceReconnect: (reason: string) => Promise<void> } | null,
): (reason: string) => Promise<void> {
  return async (reason: string) => {
    const lifecycle = getLifecycle()
    if (!lifecycle) return
    await lifecycle.forceReconnect(reason)
  }
}

// Wires the SDK push handler onto WsClient.onPush. Returns the unsubscribe
// returned by onPush so the account-shutdown path can drop the listener.
//
// This handler runs alongside (NOT instead of) the always-respond resolver
// listener — both subscribe via `wsClient.onPush(...)` and WsClient fans out
// to every registered listener for each push event.
export function registerSdkPushHandler(args: {
  wsClient: WsClient
  store: RuntimeStore
  accountId: string
  limits: FileUploadLimits
  logger: Logger
}): () => void {
  const { wsClient, store, accountId, limits, logger } = args
  // Per-account dedup: one BoundedSeen per registerSdkPushHandler call so an
  // unknown method evicted on account A cannot silently re-flood the log on
  // account B (and vice versa).
  const seenUnknownMethods = new BoundedSeen()
  return wsClient.onPush((method, payload) => {
    handleSdkPushEvent(method, payload, {
      limits,
      invalidateChatState: (chatId) => invalidateChatState(store, accountId, chatId),
      logger,
      seenUnknownMethods,
    })
  })
}

function clearAccountChats(accountId: string): void {
  const prefix = `${accountId}\u0000`
  for (const key of Array.from(store.directChatsByStableUserId.keys())) {
    if (key.startsWith(prefix)) store.directChatsByStableUserId.delete(key)
  }
  // NOTE: lastInboundRouteByAccount is intentionally NOT cleared here.
  // clearAccountChats runs on WS reconnect; peer identity and group chatIds
  // both survive a reconnect, so keeping the cache lets redirects keep
  // working until a genuine shutdown. Process-level reset happens via
  // __resetForTesting or module reload.
}

export const channelPlugin = {
  id: "trueconf" as const,

  meta: {
    id: "trueconf" as const,
    label: "TrueConf",
    selectionLabel: "TrueConf Server",
    docsPath: "/channels/trueconf",
    blurb: "Connect OpenClaw to TrueConf Server corporate messenger.",
    order: 80,
    aliases: ["tc"],
  },

  capabilities: {
    chatTypes: ["direct", "group"] as ("direct" | "group" | "thread")[],
    reactions: false,
    threads: false,
    media: true,
    polls: false,
    nativeCommands: false,
    blockStreaming: false,
  },

  // TrueConf JIDs are `user@server` with an optional per-connection `/resource`
  // suffix. The SDK's tools.message pipeline falls back to `currentChannelId`
  // when the LLM omits a target, and currentChannelId is our own botUserId.
  // Without a normalizer + id recognizer the SDK's resolver rejects the JID
  // with `Unknown target` before our outbound is called — which is why the
  // self-send redirect in sendText/sendMedia never got the chance to run.
  messaging: {
    normalizeTarget: (raw: string): string => raw.replace(/\/.*$/, '').trim(),
    targetResolver: {
      looksLikeId: (_raw: string, normalized: string): boolean =>
        /^[^@\s/]+@[^@\s/]+$/.test(normalized),
      hint: "<user@server>",
    },
  },

  config: {
    listAccountIds: (cfg: unknown) => listAccountIdsImpl(getChannelConfig(cfg)),
    // Required by openclaw 2026.4.21+ onboard at onboard-channels-*.js:275
    // (`plugin.config.defaultAccountId?.(cfg) ?? plugin.config.listAccountIds(cfg)[0] ?? "default"`).
    // Mirrors src/plugin-base.ts so setup-entry and channel.ts stay in lockstep.
    defaultAccountId: (cfg: unknown) =>
      listAccountIdsImpl(getChannelConfig(cfg))[0] ?? 'default',
    resolveAccount: (cfg: unknown, accountId?: string | null) =>
      resolveAccountImpl(getChannelConfig(cfg), accountId),
    isConfigured: (account: ResolvedAccount) => isConfiguredImpl(account),
    isEnabled: (account: ResolvedAccount) => isEnabledImpl(account),
    describeAccount: (account: ResolvedAccount) => describeAccountImpl(account),
  },

  // setupWizard / setup duplicated here so the integrated onboard works in
  // BOTH the setup-only entry path (src/setup-entry.ts loads the same factory)
  // AND the full-runtime path (this module). createTrueconfPluginBase is the
  // single source of truth for what the surface must look like.
  setupWizard: trueconfSetupWizard,
  setup: trueconfSetupAdapter,

  outbound: {
    deliveryMode: "direct" as const,
    sendText: async (ctx: { accountId?: string; to: string; text: string }) => {
      const accountId = ctx.accountId ?? store.accounts.keys().next().value
      const entry = accountId ? store.accounts.get(accountId) : undefined
      const logger = store.logger
      if (!entry || !logger) {
        logger?.error(`[trueconf] sendText: no connection for account ${accountId}`)
        return { channel: 'trueconf', messageId: '' }
      }

      const to = ctx.to?.replace(/\/.*$/, '').trim() ?? ''
      if (!to || to.includes('\u0000')) {
        logger.error(`[trueconf] sendText: invalid ctx.to ${JSON.stringify(ctx.to)}`)
        return { channel: 'trueconf', messageId: '' }
      }

      // Gateway tool-path occasionally routes `ctx.to` back to the bot's own
      // identity (ctxPayload.To === recipientAddress). Redirect to the most
      // recent inbound conversation so agent replies still land where the
      // user asked; createP2PChat on self would hang 30s anyway. For group
      // inbounds we route through sendTextToChat (no P2P resolution) so the
      // reply lands in the group chat — not in a stale DM peer.
      const botUserId = entry.wsClient.botUserId
      const cleanText = sanitizeMarkdown(ctx.text)
      if (botUserId && normalizeForCompare(botUserId) === normalizeForCompare(to)) {
        const route = store.lastInboundRouteByAccount.get(accountId ?? '')
        if (!route) {
          logger.info(
            `[trueconf] sendText: target=${to} is bot identity and no cached inbound route; skipping`,
          )
          return { channel: 'trueconf', messageId: '' }
        }
        if (route.kind === 'group') {
          logger.info(
            `[trueconf] sendText: target=${to} is bot identity; redirecting to last inbound group ${route.chatId}`,
          )
          const groupResult = await sendTextToChat(entry.wsClient, route.chatId, cleanText, logger, entry.sendQueue)
          if (groupResult.ok && groupResult.messageId) {
            rememberBotMessage(store.recentBotMsgIdsByChat, groupResult.chatId, groupResult.messageId)
          }
          return { channel: 'trueconf', messageId: groupResult.ok ? (groupResult.messageId ?? '') : '' }
        }
        logger.info(
          `[trueconf] sendText: target=${to} is bot identity; redirecting to last inbound peer ${route.userId}`,
        )
        const directResult = await sendText(entry.wsClient, route.userId, cleanText, logger, {
          fallbackUserId: route.userId,
          directChatStore: store,
          accountId,
          sendQueue: entry.sendQueue,
        })
        if (directResult.ok && directResult.messageId) {
          rememberBotMessage(store.recentBotMsgIdsByChat, directResult.chatId, directResult.messageId)
        }
        return { channel: 'trueconf', messageId: directResult.ok ? (directResult.messageId ?? '') : '' }
      }

      const result = await sendText(entry.wsClient, to, cleanText, logger, {
        fallbackUserId: to,
        directChatStore: store,
        accountId,
        sendQueue: entry.sendQueue,
      })
      if (result.ok && result.messageId) {
        rememberBotMessage(store.recentBotMsgIdsByChat, result.chatId, result.messageId)
      }
      return { channel: 'trueconf', messageId: result.ok ? (result.messageId ?? '') : '' }
    },

    sendMedia: async (ctx: {
      accountId?: string
      to: string
      text?: string
      mediaUrl?: string
      mediaLocalRoots?: readonly string[]
    }) => {
      const accountId = ctx.accountId ?? store.accounts.keys().next().value
      const entry = accountId ? store.accounts.get(accountId) : undefined
      const logger = store.logger

      if (!entry || !logger || !store.channelConfig) {
        logger?.error(`[trueconf] sendMedia: no connection for account ${accountId}`)
        return { channel: 'trueconf', messageId: '' }
      }

      const resolved = resolveAccountImpl(store.channelConfig, accountId)
      if (!resolved.serverUrl) {
        logger.error(`[trueconf] sendMedia: account ${accountId} has no serverUrl`)
        return { channel: 'trueconf', messageId: '' }
      }

      // Same fallback as sendText: if the gateway sets media ctx.to to the
      // bot's own identity, redirect to the most recent inbound conversation.
      // For group inbounds we dispatch via handleOutboundAttachmentToChat so
      // the file lands in the group chatId directly — the previous DM-only
      // fallback either misrouted to a stale DM peer or silently skipped.
      const botUserIdMedia = entry.wsClient.botUserId
      const normalizedTo = (ctx.to ?? '').replace(/\/.*$/, '').trim()
      const commonDeps = {
        wsClient: entry.wsClient,
        outboundQueue: entry.outboundQueue,
        resolved: { serverUrl: resolved.serverUrl, useTls: resolved.useTls ?? true, port: resolved.port },
        channelConfig: store.channelConfig,
        logger,
        dispatcher: entry.dispatcher,
        limits: entry.limits,
        sendQueue: entry.sendQueue,
      }
      if (botUserIdMedia && normalizeForCompare(botUserIdMedia) === normalizeForCompare(normalizedTo)) {
        const route = store.lastInboundRouteByAccount.get(accountId ?? '')
        if (!route) {
          logger.info(
            `[trueconf] sendMedia: target=${ctx.to} is bot identity and no cached inbound route; skipping`,
          )
          return { channel: 'trueconf', messageId: '' }
        }
        if (route.kind === 'group') {
          logger.info(
            `[trueconf] sendMedia: target=${ctx.to} is bot identity; redirecting to last inbound group ${route.chatId}`,
          )
          const groupResult = await handleOutboundAttachmentToChat(
            {
              chatId: route.chatId,
              text: ctx.text ?? '',
              mediaUrl: ctx.mediaUrl,
              mediaLocalRoots: ctx.mediaLocalRoots,
            },
            commonDeps,
          )
          if (groupResult.ok) {
            rememberBotMessage(store.recentBotMsgIdsByChat, groupResult.chatId, groupResult.messageId)
          }
          return { channel: 'trueconf', messageId: groupResult.ok ? groupResult.messageId : '' }
        }
        logger.info(
          `[trueconf] sendMedia: target=${ctx.to} is bot identity; redirecting to last inbound peer ${route.userId}`,
        )
        const directResult = await handleOutboundAttachment(
          {
            to: route.userId,
            text: ctx.text ?? '',
            mediaUrl: ctx.mediaUrl,
            mediaLocalRoots: ctx.mediaLocalRoots,
            accountId,
          },
          { ...commonDeps, store },
        )
        if (directResult.ok) {
          rememberBotMessage(store.recentBotMsgIdsByChat, directResult.chatId, directResult.messageId)
        }
        return { channel: 'trueconf', messageId: directResult.ok ? directResult.messageId : '' }
      }

      const result = await handleOutboundAttachment(
        {
          to: ctx.to ?? '',
          text: ctx.text ?? '',
          mediaUrl: ctx.mediaUrl,
          mediaLocalRoots: ctx.mediaLocalRoots,
          accountId,
        },
        {
          wsClient: entry.wsClient,
          outboundQueue: entry.outboundQueue,
          resolved: { serverUrl: resolved.serverUrl, useTls: resolved.useTls ?? true, port: resolved.port },
          store,
          channelConfig: store.channelConfig,
          logger,
          dispatcher: entry.dispatcher,
          limits: entry.limits,
          sendQueue: entry.sendQueue,
        },
      )

      if (result.ok) {
        rememberBotMessage(store.recentBotMsgIdsByChat, result.chatId, result.messageId)
      }
      return { channel: 'trueconf', messageId: result.ok ? result.messageId : '' }
    },
  },

  gateway: {
    startAccount: async (ctx: {
      accountId: string
      setStatus: (next: Record<string, unknown>) => void
      abortSignal?: AbortSignal
    }) => {
      const logger = store.logger
      if (!logger || !store.channelConfig) return

      const { accountId, setStatus } = ctx
      setStatus({ accountId, running: true, lastStartAt: Date.now() })

      // Capture once after the guard so closures keep the proven non-null
      // reference instead of `store.channelConfig!`, which would NPE if the
      // early return ever moves.
      const channelConfig = store.channelConfig
      const resolved = resolveAccountImpl(channelConfig, accountId)
      if (!resolved.serverUrl || !resolved.username || !resolved.password) {
        logger.error(`[trueconf] startAccount: account ${accountId} missing required config`)
        setStatus({ accountId, running: false, lastError: 'missing required config' })
        return
      }

      // Two separate TLS trust surfaces: the `ws` library accepts `ca: Buffer`
      // directly; the built-in HTTP client (undici-backed) needs a Dispatcher
      // built with that CA. If caPath is unset, both stay undefined and the
      // runtime uses the system trust store. loadCaFromAccount throws when
      // caPath is set but unreadable so we never silently downgrade pinned
      // trust to the system store.
      let ca: Buffer | undefined
      try {
        ca = loadCaFromAccount(resolved)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[trueconf] startAccount ${accountId}: ${msg}`)
        setStatus({ accountId, running: false, lastStopAt: Date.now(), lastError: msg })
        return
      }
      const tlsVerify = resolved.tlsVerify !== false
      const dispatcher: Dispatcher | undefined = !tlsVerify
        ? new UndiciAgent({ connect: { rejectUnauthorized: false } })
        : ca
          ? new UndiciAgent({ connect: { ca } })
          : undefined

      // Per-account state. Construct BEFORE wsClient/lifecycle so the
      // forceReconnect closure and the SDK push handler can capture them.
      const limits = new FileUploadLimits(getMaxFileSize(channelConfig), logger)
      const sendQueue = new PerChatSendQueue()

      // Lazy-bound lifecycle reference: the wsClient receives `forceReconnect`
      // as a closure that resolves the lifecycle at call time. WsClient is
      // constructed first because `lifecycle` needs it; the closure stays safe
      // because requests gate on the auth barrier that lifecycle.start() flips.
      let lifecycleRef: ConnectionLifecycle | null = null
      const wsClient = new WsClient({
        ca,
        tlsVerify,
        forceReconnect: makeForceReconnectAdapter(() => lifecycleRef),
      })
      wsClient.logger = logger
      const outboundQueue = new OutboundQueue(wsClient, logger)

      const wireAdapter: WireAdapter = {
        get botUserId() { return wsClient.botUserId },
        getChats: async (page, pageSize) => {
          const resp = await wsClient.sendRequest('getChats', { count: pageSize, page })
          const errorCode = responseErrorCode(resp)
          if (errorCode !== undefined && errorCode !== 0) {
            throw new Error(`getChats: unexpected response (errorCode=${errorCode})`)
          }
          // TrueConf returns the chat list as a bare array in `payload`
          // (`{ type: 2, id, payload: [chat0, chat1, ...] }`). Accept the
          // wrapped `payload.chats` shape too so older / mocked / proxied
          // servers that follow the convention used by some other endpoints
          // still work.
          const p = resp.payload as unknown
          type ChatRow = { chatId: string; title: string; chatType: number }
          if (Array.isArray(p)) return p as ChatRow[]
          const wrapped = (p as { chats?: ChatRow[] } | undefined)?.chats
          return wrapped ?? []
        },
        getChatByID: async (chatId) => {
          const resp = await wsClient.sendRequest('getChatByID', { chatId })
          // Some TrueConf servers omit errorCode on success; treat undefined
          // as success to match resolveChatType (inbound.ts) and avoid
          // skipping every push lookup against those servers.
          const errorCode = responseErrorCode(resp)
          if (errorCode !== undefined && errorCode !== 0) return null
          return { chatType: Number(resp.payload?.chatType), title: String(resp.payload?.title ?? '') }
        },
      }

      const alwaysRespond = new AlwaysRespondResolver(
        parseAlwaysRespondConfig(channelConfig.groupAlwaysRespondIn, logger),
        wireAdapter,
        logger,
      )

      const lifecycle = new ConnectionLifecycle(
        wsClient,
        {
          serverUrl: resolved.serverUrl,
          username: resolved.username,
          password: resolved.password,
          useTls: resolved.useTls ?? true,
          port: resolved.port,
          clientId: resolved.clientId,
          clientSecret: resolved.clientSecret,
        },
        logger,
        {
          onConnectionClosed: () => clearAccountChats(accountId),
          onConnected: () => setStatus({ accountId, running: true, connected: true, lastStartAt: Date.now() }),
          onDisconnected: () => setStatus({ accountId, connected: false }),
          onTerminalFailure: (err) => outboundQueue.failAll(err),
          dispatcher,
        },
      )
      lifecycleRef = lifecycle

      // Hoisted so the dep bag isn't rebuilt per turn. The DM branch layers
      // `store` on top because handleOutboundAttachment needs the direct-chat
      // cache; handleOutboundAttachmentToChat does not.
      const transport = {
        wsClient,
        outboundQueue,
        resolved: { serverUrl: resolved.serverUrl, useTls: resolved.useTls ?? true, port: resolved.port },
        channelConfig,
        logger,
        dispatcher,
        limits,
        sendQueue,
      }

      // Routes via the SDK's text/media split so a media-only payload reaches
      // sendFile instead of being JSON-stringified into the chat as text.
      const deliver = (inbound: InboundMessage) => async (payload: OutboundReplyPayload): Promise<void> => {
        const reply = resolveSendableOutboundReplyParts(payload)
        if (!reply.hasContent) return

        await deliverTextOrMediaReply({
          payload,
          text: reply.text,
          sendText: async (chunk) => {
            const result = inbound.isGroup
              ? await sendTextToChat(wsClient, inbound.chatId, chunk, logger, sendQueue)
              : await sendText(wsClient, inbound.peerId, chunk, logger, {
                  fallbackUserId: inbound.peerId,
                  directChatStore: store,
                  accountId,
                  sendQueue,
                })
            if (!result.ok) {
              logger.warn(`[trueconf] deliver: text chunk send failed (peer=${inbound.peerId}, isGroup=${inbound.isGroup})`)
              return
            }
            if (result.messageId) {
              rememberBotMessage(store.recentBotMsgIdsByChat, result.chatId, result.messageId)
            }
          },
          sendMedia: async ({ mediaUrl, caption }) => {
            if (inbound.isGroup) {
              const result = await handleOutboundAttachmentToChat(
                { chatId: inbound.chatId, text: caption ?? '', mediaUrl },
                transport,
              )
              if (result.ok && result.messageId) {
                rememberBotMessage(store.recentBotMsgIdsByChat, result.chatId, result.messageId)
              }
            } else {
              const result = await handleOutboundAttachment(
                { to: inbound.peerId, text: caption ?? '', mediaUrl, accountId },
                { ...transport, store },
              )
              if (result.ok && result.messageId) {
                rememberBotMessage(store.recentBotMsgIdsByChat, result.chatId, result.messageId)
              }
            }
          },
        })
      }

      const dispatch = async (inboundMsg: InboundMessage) => {
        // dmPolicy applies only to direct chats. Group chats have their own
        // activation gate (mention/reply) which has already passed if we got here.
        if (!inboundMsg.isGroup && !shouldAllowMessage(store.channelConfig!, inboundMsg.peerId)) {
          logger.info(`[trueconf] DM blocked for ${inboundMsg.peerId} by policy`)
          return
        }

        // Remember the last inbound conversation for the self-send redirect.
        // Groups track chatId (dispatched via sendTextToChat, no P2P lookup);
        // DMs track peerId (the user JID, used by sendText + resolveDirectChat).
        store.lastInboundRouteByAccount.set(
          accountId,
          inboundMsg.isGroup
            ? { kind: 'group', chatId: inboundMsg.chatId }
            : { kind: 'direct', userId: inboundMsg.peerId },
        )

        let rawBody = inboundMsg.text
        // Inbound's per-envelope hints (TrueConfEnvelopeType for FORWARDED /
        // LOCATION / SURVEY) come in via inboundMsg.extraContext and must
        // survive the merge below — shadowing them with attachment-only fields
        // would lose forwarded / location metadata when both shapes co-exist
        // (e.g., forwarded message with attachment).
        let mediaExtraContext: InboundMediaContext | undefined
        let tempPath: string | null = null

        if (inboundMsg.attachmentContent) {
          const prep = await prepareInboundAttachment({
            inboundMsg,
            wsClient,
            accountId,
            store,
            channelConfig: store.channelConfig!,
            logger,
            sendQueue,
            dispatcher,
          })
          if (!prep.ok) return
          // Preserve the real caption when the inbound was coalesced from a
          // separate 200+202 pair. Fall back to the sanitized placeholder when
          // the upstream synthesized a "[File:..." stub (no caption case).
          const placeholder = `[${prep.kindLabel}: ${prep.sanitizedName}]`
          const looksSynthesized =
            inboundMsg.text.startsWith('[File:') || inboundMsg.text.startsWith('[Image:')
          rawBody = looksSynthesized ? placeholder : inboundMsg.text
          mediaExtraContext = {
            MediaPath: prep.tempPath,
            MediaType: prep.mimeType,
            MediaPaths: [prep.tempPath],
            MediaTypes: [prep.mimeType],
          }
          tempPath = prep.tempPath
        }

        // Merge inbound-side envelope hint (forwarded/location/survey) with
        // attachment-side media context. Either, both, or neither may be
        // present; the merged shape is captured by InboundExtraContext.
        const baseExtra = inboundMsg.extraContext
        let extraContext: InboundExtraContext | undefined
        if (baseExtra && mediaExtraContext) {
          extraContext = { ...baseExtra, ...mediaExtraContext }
        } else if (baseExtra) {
          extraContext = baseExtra
        } else if (mediaExtraContext) {
          extraContext = mediaExtraContext
        }
        const hasExtra = extraContext !== undefined

        // Suppress slash-command interpretation for any envelope-flavoured
        // message: ATTACHMENT replaces the body with `[File: name]`, FORWARDED
        // synthesises a forward header, LOCATION/SURVEY synthesise a
        // descriptive placeholder. None of those should be parsed as
        // gateway-control commands by the runtime.
        const isCommand = !hasExtra && ((store.runtime as {
          channel?: { commands?: { isControlCommandMessage?: (t: string) => boolean } }
        })?.channel?.commands?.isControlCommandMessage?.(inboundMsg.text) ?? false)

        // The dispatcher reports failures along three paths: sync throw,
        // onRecordError (session record failed → file is orphaned), and
        // onDispatchError (reply send failed → file is at minimum suspect).
        // Idempotent cleanup unifies all three so a callback-routed failure
        // doesn't silently leak the temp file.
        let tempCleaned = false
        const cleanupTemp = async () => {
          if (tempPath && !tempCleaned) {
            tempCleaned = true
            await unlinkTempFile(tempPath, logger)
          }
        }

        try {
          await dispatchInboundDirectDmWithRuntime({
            cfg: store.fullConfig as Parameters<typeof dispatchInboundDirectDmWithRuntime>[0]['cfg'],
            runtime: store.runtime as Parameters<typeof dispatchInboundDirectDmWithRuntime>[0]['runtime'],
            channel: 'trueconf',
            channelLabel: 'TrueConf',
            accountId,
            peer: { kind: 'direct' as const, id: inboundMsg.peerId },
            senderId: inboundMsg.senderId,
            senderAddress: inboundMsg.senderId,
            // Strip the per-connection /resource suffix: ctx.To and
            // currentChannelId must be stable across reconnects, and downstream
            // target resolution operates on bare JIDs.
            recipientAddress: (wsClient.botUserId ?? '').replace(/\/.*$/, '').trim(),
            conversationLabel: inboundMsg.isGroup
              ? `Group ${inboundMsg.chatId}`
              : `DM with ${inboundMsg.peerId}`,
            rawBody,
            messageId: inboundMsg.messageId,
            timestamp: inboundMsg.timestamp,
            commandBody: isCommand ? inboundMsg.text : undefined,
            commandAuthorized: isCommand ? true : undefined,
            extraContext: widenExtraContext(extraContext),
            deliver: deliver(inboundMsg),
            onRecordError: (err: unknown) => {
              logger.error(`[trueconf] Record error: ${err instanceof Error ? err.message : String(err)}`)
              void cleanupTemp()
            },
            onDispatchError: (err: unknown, info: { kind: string }) => {
              logger.error(`[trueconf] Dispatch error (${info.kind}): ${err instanceof Error ? err.message : String(err)}`)
              void cleanupTemp()
            },
          })
        } catch (err) {
          logger.error(`[trueconf] dispatchInboundDirectDm failed: ${err instanceof Error ? err.message : String(err)}`)
          await cleanupTemp()
        }
      }

      wsClient.onInboundMessage = (msg) => {
        try {
          setStatus({ accountId, lastInboundAt: Date.now() })
        } catch (err) {
          logger.warn(`[trueconf] setStatus(lastInboundAt) failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        const inboundCtx: InboundContext = {
          wsClient,
          botIdentityCandidates: [wsClient.botUserId ?? '', resolved.username ?? ''],
          accountId,
          dispatch,
          logger,
          directChats: store.directChatsByStableUserId,
          chatTypes: store.chatTypeByChatId,
          inflightChatTypes: store.inflightChatTypeLookups,
          recentBotMsgIds: store.recentBotMsgIdsByChat,
          isAlwaysRespond: alwaysRespond.isAlwaysRespond,
        }
        Promise.resolve(handleInboundMessage(msg, inboundCtx)).catch((err) => {
          logger.error(`[trueconf] handleInboundMessage threw: ${err instanceof Error ? err.message : String(err)}`)
        })
      }

      const unsubscribePush = wsClient.onPush((method, payload) => {
        const ev = mapPushToResolverEvent(method, payload, logger)
        if (ev) alwaysRespond.enqueueEvent(ev)
      })
      const unsubscribeAuth = wsClient.onAuth(() => {
        void alwaysRespond.rebuildFromWire().catch((err) => {
          logger.warn(`[trueconf] always-respond: re-auth rebuild failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      })
      // SDK-push handler runs ALONGSIDE the always-respond push listener:
      // both subscribe via onPush and WsClient fans out to every listener.
      // Routes server-side getFileUploadLimits / removeChat / editMessage /
      // removeMessage / clearHistory pushes to the right handlers.
      const unsubscribeSdkPush = registerSdkPushHandler({
        wsClient,
        store,
        accountId,
        limits,
        logger,
      })

      store.accounts.set(accountId, {
        lifecycle,
        wsClient,
        dispatcher,
        unsubscribers: [unsubscribePush, unsubscribeAuth, unsubscribeSdkPush],
        limits,
        sendQueue,
        outboundQueue,
      })

      try {
        await lifecycle.start()
      } catch (err) {
        logger.error(`[trueconf] Account ${accountId} startup failed: ${err instanceof Error ? err.message : String(err)}`)
        setStatus({
          accountId,
          running: false,
          lastStopAt: Date.now(),
          lastError: err instanceof Error ? err.message : String(err),
        })
        return
      }

      await waitUntilAbort(ctx.abortSignal, () => {
        const entry = store.accounts.get(accountId)
        if (entry) shutdownAccountEntry(entry)
        store.accounts.delete(accountId)
        clearAccountChats(accountId)
        setStatus({ accountId, running: false, lastStopAt: Date.now() })
      })
    },
  },
}

export function registerFull(api: OpenClawPluginApi): void {
  const logger: Logger = api.logger
  store.logger = logger
  store.runtime = api.runtime
  store.fullConfig = api.config
  pluginRuntimeStore.setRuntime(api.runtime)
  store.channelConfig = getChannelConfig(api.config)

  validateStartupConfig(store.channelConfig, logger)

  api.on('gateway_stop', async () => {
    logger.info(`[trueconf] Shutting down ${store.accounts.size} connection(s)`)
    for (const [, entry] of store.accounts) shutdownAccountEntry(entry)
    store.accounts.clear()
    store.directChatsByStableUserId.clear()
    store.chatTypeByChatId.clear()
    store.inflightChatTypeLookups.clear()
    store.recentBotMsgIdsByChat.clear()
  })
}

// Invalid values are silently normalized by the resolver; we warn once here so
// the misconfiguration is visible at startup.
function validateStartupConfig(channelConfig: TrueConfChannelConfig, logger: Logger): void {
  const max = (channelConfig as { maxFileSize?: unknown }).maxFileSize
  if (max !== undefined) {
    const valid =
      typeof max === 'number' && Number.isFinite(max) && max > 0 && max <= MAX_FILE_SIZE_HARD_LIMIT_BYTES
    if (!valid) logger.warn(`[trueconf] Invalid maxFileSize: ${JSON.stringify(max)}. Using fallback 50 MB.`)
  }

  const rawCfg = channelConfig as { accounts?: Record<string, { port?: unknown }>; port?: unknown }
  for (const accountId of listAccountIdsImpl(channelConfig)) {
    const rawPort =
      rawCfg.accounts?.[accountId]?.port ?? (accountId === 'default' ? rawCfg.port : undefined)
    if (rawPort === undefined) continue
    const valid = typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
    if (!valid) {
      logger.warn(
        `[trueconf] Invalid port for account ${accountId}: ${JSON.stringify(rawPort)}. Stripping; will use scheme default (4309 for ws, 443 for wss).`,
      )
    }
  }
}

export function __resetForTesting(): void {
  store.accounts.clear()
  store.channelConfig = null
  store.logger = null
  store.runtime = null
  store.fullConfig = null
  store.directChatsByStableUserId.clear()
  store.lastInboundRouteByAccount.clear()
  store.chatTypeByChatId.clear()
  store.inflightChatTypeLookups.clear()
  store.recentBotMsgIdsByChat.clear()
  __resetCoalesceBufferForTesting()
  pluginRuntimeStore.clearRuntime()
}

// Test-only handle. Returns the live store.accounts Map by reference;
// do NOT mutate from production code paths.
export function __getAccountsForTesting(): Map<string, AccountEntry> {
  return store.accounts
}
