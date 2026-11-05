import { vi } from 'vitest'

// Factory for vi.mock('openclaw/plugin-sdk/channel-inbound'). The context
// builder returns its input, so a test reads exactly what the plugin handed
// the SDK. Routing (plugin-sdk/routing) and the envelope formatter are
// OpenClaw's own, with timestamps off so bodies are literal. The real context
// builder is covered by group-session-routing.test.ts.
export async function channelInboundMock() {
  const actual = await vi.importActual<typeof import('openclaw/plugin-sdk/channel-inbound')>(
    'openclaw/plugin-sdk/channel-inbound',
  )
  return {
    dispatchInboundDirectDm: vi.fn().mockResolvedValue({}),
    resolveEnvelopeFormatOptions: vi.fn(() => ({ includeTimestamp: false })),
    formatInboundEnvelope: actual.formatInboundEnvelope,
    buildChannelInboundEventContext: vi.fn(async (params: unknown) => params),
    dispatchChannelInboundTurn: vi.fn(recordedTurn),
  }
}

// A dispatchChannelInboundTurn that, like OpenClaw's, calls afterRecord before
// the agent would run.
export async function recordedTurn(params: { afterRecord?: () => void | Promise<void> }) {
  await params.afterRecord?.()
  return {}
}

// One dispatchChannelInboundTurn call as the group path builds it, with
// ctxPayload being the buildChannelInboundEventContext input.
export interface GroupTurn {
  route: { sessionKey: string }
  afterRecord?: () => void | Promise<void>
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
