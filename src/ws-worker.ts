import { parentPort, workerData } from 'node:worker_threads'
import { WsCore, type TerminalCause as CoreTerminalCause } from './ws-core'
import {
  serializeError,
  PROTOCOL_VERSION,
  type MainToWorker,
  type WorkerToMain,
  type WsCoreConfig,
  type LogLevel,
  type TerminalCause as WireTerminalCause,
} from './ws-worker-protocol'

if (!parentPort) {
  throw new Error('ws-worker: must be spawned as a worker_thread')
}

const config = workerData as WsCoreConfig
const port = parentPort

const post = (m: WorkerToMain, transfer?: ReadonlyArray<ArrayBuffer>): void => {
  if (transfer && transfer.length > 0) port.postMessage(m, transfer as ArrayBuffer[])
  else port.postMessage(m)
}

const log = (level: LogLevel, msg: string, meta?: unknown): void =>
  post({ kind: 'log', level, msg, meta })

const toWireTerminalCause = (cause: CoreTerminalCause): WireTerminalCause => {
  switch (cause.kind) {
    case 'shutdown': return { kind: 'shutdown' }
    case 'dns_exhausted': return { kind: 'dns_exhausted' }
    case 'auth_exhausted': return { kind: 'auth_exhausted' }
  }
}

const core = new WsCore({
  account: config.account,
  logger: {
    info: (m) => log('info', m),
    warn: (m) => log('warn', m),
    error: (m) => log('error', m),
  },
  ca: config.ca,
  tlsVerify: config.tlsVerify,
})

core.onState = (state, detail) => post({ kind: 'state', state, detail })
core.onAuth((botUserId) => post({ kind: 'auth', botUserId }))
core.onAuthLost((reason) => post({ kind: 'authLost', reason }))
core.onInboundMessage = (msg) =>
  post({ kind: 'inbound', method: String(msg.method ?? ''), payload: (msg as { payload?: unknown }).payload })
core.onPush((method, payload) => post({ kind: 'push', method, payload }))
core.onTerminal = (cause) => {
  post({ kind: 'terminal', cause: toWireTerminalCause(cause) })
  setTimeout(() => process.exit(cause.kind === 'shutdown' ? 0 : 1), 100).unref()
}

let lastAppPingAt = Date.now()

port.on('message', async (m: MainToWorker) => {
  try {
    switch (m.kind) {
      case 'init':
        post({ kind: 'ready', protocolVersion: PROTOCOL_VERSION })
        break
      case 'sendRequest': {
        try {
          const response = await core.sendRequest(m.method, m.payload as Record<string, unknown>)
          post({ kind: 'response', reqId: m.reqId, ok: true, data: response })
        } catch (err) {
          post({ kind: 'response', reqId: m.reqId, ok: false, error: serializeError(err) })
        }
        break
      }
      case 'forceReconnect':
        await core.forceReconnect(m.reason)
        break
      case 'fileProgressSubscribe':
        // Local listener registration only. Server-side subscribeFileProgress
        // call stays in inbound.ts (via handle.sendRequest) so its existing
        // error-handling (subscribe_failed branch) is unchanged.
        core.onFileProgress(m.fileId, (progress) =>
          post({ kind: 'fileProgress', fileId: m.fileId, progress }),
        )
        break
      case 'fileProgressUnsubscribe':
        core.offFileProgress(m.fileId)
        break
      case 'appPing':
        lastAppPingAt = Date.now()
        post({ kind: 'appPong', nonce: m.nonce })
        break
      case 'shutdown':
        core.shutdown()
        post({ kind: 'terminal', cause: { kind: 'shutdown' } })
        setTimeout(() => process.exit(0), 50).unref()
        break
    }
  } catch (err) {
    log('error', `[ws-worker] message handler threw: ${err instanceof Error ? err.message : String(err)}`)
  }
})

setInterval(() => {
  if (Date.now() - lastAppPingAt > 20_000) {
    log('error', '[ws-worker] main unresponsive >20s, exiting')
    core.shutdown()
    setTimeout(() => process.exit(2), 200).unref()
  }
}, 10_000).unref()

process.on('unhandledRejection', (reason) => {
  log('error', `[ws-worker] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`)
})

void core.start()
