import { vi } from 'vitest'

// Factory for vi.mock('openclaw/plugin-sdk/channel-inbound'). Group routing is
// faked so no session store on disk is touched, and the context builder
// returns its input, so a test reads exactly what the plugin handed the SDK.
// Real OpenClaw routing is covered by group-session-routing.test.ts.
export function channelInboundMock() {
  return {
    dispatchInboundDirectDm: vi.fn().mockResolvedValue({}),
    resolveChannelInboundRouteEnvelope: vi.fn(
      (params: { accountId: string; peer: { kind: string; id: string } }) => ({
        route: {
          agentId: 'main',
          accountId: params.accountId,
          sessionKey: `test:${params.peer.kind}:${params.peer.id}`,
        },
        buildEnvelope: (input: { body: string }) => input.body,
      }),
    ),
    buildChannelInboundEventContext: vi.fn(async (params: unknown) => params),
    dispatchChannelInboundTurn: vi.fn().mockResolvedValue({}),
  }
}

// One dispatchChannelInboundTurn call as the group path builds it, with
// ctxPayload being the buildChannelInboundEventContext input.
export interface GroupTurn {
  route: { sessionKey: string }
  ctxPayload: {
    from: string
    sender: { id: string }
    conversation: { kind: string; id: string; label: string }
    reply: { to: string; originatingTo: string }
    message: { body: string; rawBody: string; commandBody: string }
    access: { commands: { authorized: boolean }; mentions: { wasMentioned: boolean; requireMention: boolean } }
  }
  delivery: { deliver: (payload: { text: string }) => Promise<void> }
}
