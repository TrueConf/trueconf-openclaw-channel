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
} from './outbound'
import { handleInboundMessage, prepareInboundAttachment, unlinkTempFile, normalizeForCompare, rememberBotMessage, __resetCoalesceBufferForTesting } from './inbound'
import type { InboundContext } from './inbound'
import { buildAck } from './types'
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
import { AlwaysRespondResolver } from './always-respond'
import { WsClient, ConnectionLifecycle } from './ws-client'
import type { Logger, TrueConfChannelConfig, ResolvedAccount, InboundMessage } from './types'

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

// Tears down a single account entry: stops its lifecycle and closes the
// undici dispatcher so its keep-alive socket pool releases. Plugin hot-reload
// and rolling restart would otherwise leak sockets per account on every
// redeploy. close() rejections are swallowed — shutdown is best-effort.
export function shutdownAccountEntry(entry: {
  lifecycle: ConnectionLifecycle
  wsClient: WsClient
  dispatcher?: Dispatcher
}): void {
  entry.lifecycle.shutdown()
  entry.dispatcher?.close().catch(() => { /* best-effort */ })
}

const pluginRuntimeStore = createPluginRuntimeStore<PluginRuntime>("TrueConf runtime not initialized")

export function createRuntimeStore() {
  return {
    accounts: new Map<string, { lifecycle: ConnectionLifecycle; wsClient: WsClient; dispatcher?: Dispatcher }>(),
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

const store = createRuntimeStore()

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
    resolveAccount: (cfg: unknown, accountId?: string | null) =>
      resolveAccountImpl(getChannelConfig(cfg), accountId),
    isConfigured: (account: ResolvedAccount) => isConfiguredImpl(account),
    isEnabled: (account: ResolvedAccount) => isEnabledImpl(account),
    describeAccount: (account: ResolvedAccount) => describeAccountImpl(account),
  },

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
          const groupResult = await sendTextToChat(entry.wsClient, route.chatId, cleanText, logger)
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
        resolved: { serverUrl: resolved.serverUrl, useTls: resolved.useTls ?? true, port: resolved.port },
        channelConfig: store.channelConfig,
        logger,
        dispatcher: entry.dispatcher,
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
          resolved: { serverUrl: resolved.serverUrl, useTls: resolved.useTls ?? true, port: resolved.port },
          store,
          channelConfig: store.channelConfig,
          logger,
          dispatcher: entry.dispatcher,
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
      const alwaysRespond = new AlwaysRespondResolver(
        parseAlwaysRespondConfig(channelConfig.groupAlwaysRespondIn, logger),
      )
      const resolved = resolveAccountImpl(channelConfig, accountId)
      if (!resolved.serverUrl || !resolved.username || !resolved.password) {
        logger.error(`[trueconf] startAccount: account ${accountId} missing required config`)
        setStatus({ accountId, running: false, lastError: 'missing required config' })
        return
      }

      // Two separate TLS trust surfaces: the `ws` library accepts `ca: Buffer`
      // directly; the built-in HTTP client (undici-backed) needs a Dispatcher
      // built with that CA. If caPath is unset, both stay undefined and the
      // runtime uses the system trust store — same behavior as before Part 2.
      // loadCaFromAccount throws when caPath is set but unreadable so we never
      // silently downgrade pinned trust to the system store.
      let ca: Buffer | undefined
      try {
        ca = loadCaFromAccount(resolved)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[trueconf] startAccount ${accountId}: ${msg}`)
        setStatus({ accountId, running: false, lastStopAt: Date.now(), lastError: msg })
        return
      }
      const dispatcher: Dispatcher | undefined = ca
        ? new UndiciAgent({ connect: { ca } })
        : undefined

      const wsClient = new WsClient({ ca })
      wsClient.logger = logger

      const lifecycle = new ConnectionLifecycle(
        wsClient,
        {
          serverUrl: resolved.serverUrl,
          username: resolved.username,
          password: resolved.password,
          useTls: resolved.useTls ?? true,
          port: resolved.port,
        },
        logger,
        {
          onConnectionClosed: () => clearAccountChats(accountId),
          onConnected: () => setStatus({ accountId, running: true, connected: true, lastStartAt: Date.now() }),
          onDisconnected: () => setStatus({ accountId, connected: false }),
          dispatcher,
        },
      )

      // Hoisted so the dep bag isn't rebuilt per turn. The DM branch layers
      // `store` on top because handleOutboundAttachment needs the direct-chat
      // cache; handleOutboundAttachmentToChat does not.
      const transport = {
        wsClient,
        resolved: { serverUrl: resolved.serverUrl, useTls: resolved.useTls ?? true, port: resolved.port },
        channelConfig,
        logger,
        dispatcher,
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
              ? await sendTextToChat(wsClient, inbound.chatId, chunk, logger)
              : await sendText(wsClient, inbound.peerId, chunk, logger, {
                  fallbackUserId: inbound.peerId,
                  directChatStore: store,
                  accountId,
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
        let extraContext: Record<string, unknown> | undefined
        let tempPath: string | null = null

        if (inboundMsg.attachmentContent) {
          const prep = await prepareInboundAttachment({
            inboundMsg,
            wsClient,
            accountId,
            store,
            channelConfig: store.channelConfig!,
            logger,
          })
          if (!prep.ok) return
          // Preserve the real caption when the inbound was coalesced from a
          // separate 200+202 pair. Fall back to the sanitized placeholder when
          // the upstream synthesized a "[File:..." stub (no caption case).
          const placeholder = `[${prep.kindLabel}: ${prep.sanitizedName}]`
          const looksSynthesized =
            inboundMsg.text.startsWith('[File:') || inboundMsg.text.startsWith('[Image:')
          rawBody = looksSynthesized ? placeholder : inboundMsg.text
          extraContext = {
            MediaPath: prep.tempPath,
            MediaType: prep.mimeType,
            MediaPaths: [prep.tempPath],
            MediaTypes: [prep.mimeType],
          }
          tempPath = prep.tempPath
        }

        const isCommand = !extraContext && ((store.runtime as {
          channel?: { commands?: { isControlCommandMessage?: (t: string) => boolean } }
        })?.channel?.commands?.isControlCommandMessage?.(inboundMsg.text) ?? false)

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
            extraContext,
            deliver: deliver(inboundMsg),
            onRecordError: (err: unknown) => {
              logger.error(`[trueconf] Record error: ${err instanceof Error ? err.message : String(err)}`)
            },
            onDispatchError: (err: unknown, info: { kind: string }) => {
              logger.error(`[trueconf] Dispatch error (${info.kind}): ${err instanceof Error ? err.message : String(err)}`)
            },
          })
        } catch (err) {
          logger.error(`[trueconf] dispatchInboundDirectDm failed: ${err instanceof Error ? err.message : String(err)}`)
          if (tempPath) await unlinkTempFile(tempPath, logger)
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
          sendAck: (id) => wsClient.send(buildAck(id)),
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

      store.accounts.set(accountId, { lifecycle, wsClient, dispatcher })

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
    const valid = typeof max === 'number' && Number.isFinite(max) && max > 0 && max <= 2 * 1024 * 1024 * 1024
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
