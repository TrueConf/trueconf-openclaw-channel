import {
  buildChannelInboundEventContext,
  dispatchChannelInboundTurn,
  resolveChannelInboundRouteEnvelope,
  type dispatchInboundDirectDm,
} from 'openclaw/plugin-sdk/channel-inbound'
import { normalizeOutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload'
import type { InboundExtraContext } from './types'

// What every inbound turn carries, DM or group. The DM-only fields stay with
// the dispatchInboundDirectDm call.
export type InboundTurn = Omit<
  Parameters<typeof dispatchInboundDirectDm>[0],
  'channel' | 'channelLabel' | 'peer' | 'senderAddress' | 'conversationLabel' | 'extraContext'
> & { extraContext?: InboundExtraContext }

export type GroupInboundParams = InboundTurn & { chatId: string }

// The SDK's dispatchInboundDirectDm with a group peer. That helper hardcodes
// conversation kind "direct", so under the default session.dmScope "main"
// every group chat would land in the agent's main DM session.
export async function dispatchGroupInbound(params: GroupInboundParams): Promise<void> {
  const peer = { kind: 'group' as const, id: params.chatId }
  const label = `Group ${params.chatId}`
  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg: params.cfg,
    channel: 'trueconf',
    accountId: params.accountId,
    peer,
  })
  const accountId = route.accountId ?? params.accountId
  const ctxPayload = await buildChannelInboundEventContext({
    channel: 'trueconf',
    accountId,
    messageId: params.messageId,
    messageIdFull: params.messageId,
    timestamp: params.timestamp,
    from: params.senderId,
    sender: { id: params.senderId, name: params.senderId },
    conversation: { kind: 'group', id: params.chatId, routePeer: peer, label },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: { to: params.recipientAddress, originatingTo: params.senderId },
    message: {
      body: buildEnvelope({ channel: 'TrueConf', from: label, body: params.rawBody, timestamp: params.timestamp }),
      bodyForAgent: params.rawBody,
      rawBody: params.rawBody,
      commandBody: params.commandBody ?? params.rawBody,
    },
    access: {
      commands: { authorized: params.commandAuthorized === true },
      // The inbound gate already dropped group messages that neither mention
      // nor reply to the bot outside always-respond chats, so every group
      // turn that gets here is addressed to the bot.
      mentions: { canDetectMention: true, wasMentioned: true },
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
