import { Agent, type Dispatcher } from 'undici'

// We bundle our own undici and call its `fetch`/`request`. With no explicit
// dispatcher, those route through the process-global dispatcher — which the
// host runtime (OpenClaw core) replaces with a custom Agent from ITS undici
// (stream-timeout / env-proxy wrapping via setGlobalDispatcher). Dispatching a
// handler built by our bundled undici through that foreign Agent throws
// `UND_ERR_INVALID_ARG: invalid onRequestStart method`. Always dispatch through
// an Agent from OUR undici so fetch/request never touch the global dispatcher.
// Lazy so importing this module has no side effect; one pooled Agent is reused.
let shared: Agent | undefined

export function getDefaultDispatcher(): Dispatcher {
  return (shared ??= new Agent())
}
