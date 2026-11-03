import {
  buildChannelInboundEventContext,
  dispatchChannelInboundTurn,
  formatInboundEnvelope,
  resolveChannelInboundRouteEnvelope,
  resolveInboundSessionEnvelopeContext,
  type dispatchInboundDirectDm,
} from 'openclaw/plugin-sdk/channel-inbound'
import { normalizeOutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload'
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
export type GroupInboundParams = InboundTurn & {
  chatId: string
  title: string
  senderName: string
  wasMentioned: boolean
  requireMention: boolean
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
  const { route } = resolveChannelInboundRouteEnvelope({
    cfg: params.cfg,
    channel: 'trueconf',
    accountId: params.accountId,
    peer,
  })
  const accountId = route.accountId ?? params.accountId
  const sender = { id: params.senderId, name: params.senderName }
  const { envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: route.agentId,
    sessionKey: route.sessionKey,
  })
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
      body: formatInboundEnvelope({
        channel: 'TrueConf',
        from: label,
        body: params.rawBody,
        timestamp: params.timestamp,
        chatType: 'group',
        sender,
        previousTimestamp,
        envelope: envelopeOptions,
      }),
      // OpenClaw stores BodyForAgent as the session's user line, so a group
      // session records who said what. Commands stay bare for core's parser.
      bodyForAgent: params.commandBody === undefined
        ? `${speakerLabel(params.senderId, params.senderName)}: ${params.rawBody}`
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
    delivery: {
      deliver: async (payload) => await params.deliver(normalizeOutboundReplyPayload(payload)),
      onError: params.onDispatchError,
    },
    // An empty object still makes core build the default reply pipeline;
    // omitting the field skips it.
    replyPipeline: {},
  })
}
