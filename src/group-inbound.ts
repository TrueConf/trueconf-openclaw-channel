import {
  buildChannelInboundEventContext,
  dispatchChannelInboundTurn,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
  type dispatchInboundDirectDm,
} from 'openclaw/plugin-sdk/channel-inbound'
import { normalizeOutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload'
import { buildHistoryContextFromEntries, type HistoryEntry } from 'openclaw/plugin-sdk/reply-history'
import { resolveAgentRoute } from 'openclaw/plugin-sdk/routing'
import { groupAddress } from './target'
import type { InboundExtraContext } from './types'

// What every inbound turn carries, DM or group. The DM-only fields stay with
// the dispatchInboundDirectDm call.
export type InboundTurn = Omit<
  Parameters<typeof dispatchInboundDirectDm>[0],
  'channel' | 'channelLabel' | 'peer' | 'senderAddress' | 'recipientAddress' | 'conversationLabel' | 'extraContext'
> & { extraContext?: InboundExtraContext }

// title: the chat's TrueConf title, or empty when getChatByID did not give one.
// senderName: the sender's display name, or the sender id when unknown.
// history: unaddressed lines since the bot last answered here, oldest first,
// each sender already a speaker label.
// onRecorded: OpenClaw has recorded the turn in the group session and is about
// to run the agent, so the history is taken even if the run then fails.
export type GroupInboundParams = InboundTurn & {
  chatId: string
  title: string
  senderName: string
  history: readonly HistoryEntry[]
  wasMentioned: boolean
  requireMention: boolean
  onRecorded?: () => void
}

// "Name (id)", or the id alone when the name is unknown.
export function speakerLabel(id: string, name: string): string {
  return name === id ? id : `${name} (${id})`
}

// The SDK's dispatchInboundDirectDm with a group peer. That helper hardcodes
// conversation kind "direct", so under the default session.dmScope "main"
// every group chat would land in the agent's main DM session.
export async function dispatchGroupInbound(params: GroupInboundParams): Promise<void> {
  const peer = { kind: 'group' as const, id: params.chatId }
  const label = params.title || `Group ${params.chatId}`
  const address = groupAddress(params.chatId)
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: 'trueconf',
    accountId: params.accountId,
    peer,
  })
  const accountId = route.accountId ?? params.accountId
  const sender = { id: params.senderId, name: params.senderName }
  const ctxPayload = await buildChannelInboundEventContext({
    channel: 'trueconf',
    accountId,
    messageId: params.messageId,
    messageIdFull: params.messageId,
    timestamp: params.timestamp,
    from: address,
    sender,
    conversation: { kind: 'group', id: params.chatId, routePeer: peer, label },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: { to: address, originatingTo: address },
    message: {
      // No "+elapsed" suffix: it needs the session's last update time, and
      // every SDK reader of it is deprecated or missing in OpenClaw 2026.8.1.
      // The agent reads BodyForAgent, not Body.
      body: formatInboundEnvelope({
        channel: 'TrueConf',
        from: label,
        body: params.rawBody,
        timestamp: params.timestamp,
        chatType: 'group',
        sender,
        envelope: resolveEnvelopeFormatOptions(params.cfg),
      }),
      // OpenClaw stores BodyForAgent as the session's user line, so the
      // pending group lines and the speaker names land in the transcript.
      // Commands stay bare for core's parser.
      bodyForAgent: params.commandBody === undefined
        ? buildHistoryContextFromEntries({
            entries: [...params.history],
            currentMessage: `${speakerLabel(params.senderId, params.senderName)}: ${params.rawBody}`,
            formatEntry: (line) => `${line.sender}: ${line.body}`,
            excludeLast: false,
          })
        : params.rawBody,
      rawBody: params.rawBody,
      commandBody: params.commandBody ?? params.rawBody,
    },
    access: {
      commands: { authorized: params.commandAuthorized === true },
      mentions: {
        // Required by the SDK type; the context builder never reads it.
        canDetectMention: true,
        wasMentioned: params.wasMentioned,
        requireMention: params.requireMention,
      },
    },
    extra: params.extraContext,
  })
  await dispatchChannelInboundTurn({
    cfg: params.cfg,
    channel: 'trueconf',
    accountId,
    route: { agentId: route.agentId, sessionKey: route.sessionKey },
    ctxPayload,
    record: { onRecordError: params.onRecordError },
    afterRecord: params.onRecorded,
    delivery: {
      deliver: async (payload) => await params.deliver(normalizeOutboundReplyPayload(payload)),
      onError: params.onDispatchError,
    },
    // An empty object still makes core build the default reply pipeline;
    // omitting the field skips it.
    replyPipeline: {},
  })
}
