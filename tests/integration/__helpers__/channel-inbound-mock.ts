import { vi } from 'vitest'

// Factory for vi.mock('openclaw/plugin-sdk/channel-inbound'). Group routing is
// faked so no session store on disk is touched, and the context builder
// returns its input, so a test reads exactly what the plugin handed the SDK.
// The envelope formatter is OpenClaw's own, with timestamps off so bodies are
// literal. Real OpenClaw routing is covered by group-session-routing.test.ts.
export async function channelInboundMock() {
  const actual = await vi.importActual<typeof import('openclaw/plugin-sdk/channel-inbound')>(
    'openclaw/plugin-sdk/channel-inbound',
  )
  return {
    dispatchInboundDirectDm: vi.fn().mockResolvedValue({}),
    resolveChannelInboundRouteEnvelope: vi.fn(
      (params: { accountId: string; peer: { kind: string; id: string } }) => ({
        route: {
          agentId: 'main',
          accountId: params.accountId,
          sessionKey: `test:${params.peer.kind}:${params.peer.id}`,
        },
      }),
    ),
    resolveInboundSessionEnvelopeContext: vi.fn(() => ({
      storePath: '',
      envelopeOptions: { includeTimestamp: false },
      previousTimestamp: undefined,
    })),
    formatInboundEnvelope: actual.formatInboundEnvelope,
    buildChannelInboundEventContext: vi.fn(async (params: unknown) => params),
    dispatchChannelInboundTurn: vi.fn().mockResolvedValue({}),
  }
}

// One dispatchChannelInboundTurn call as the group path builds it, with
// ctxPayload being the buildChannelInboundEventContext input.
export interface GroupTurn {
  route: { sessionKey: string }
  ctxPayload: {
    messageId: string
    from: string
    sender: { id: string; name: string }
    conversation: { kind: string; id: string; label: string }
    reply: { to: string; originatingTo: string }
    message: { body: string; bodyForAgent: string; rawBody: string; commandBody: string }
    access: { commands: { authorized: boolean }; mentions: { wasMentioned: boolean; requireMention: boolean } }
  }
  delivery: { deliver: (payload: { text: string }) => Promise<void> }
}
