// Plugin-side e2e scenario for L1b at-least-once outbound delivery.
//
// Flow:
//   1. lifecycle.start -> connect + auth -> emit 'connected'.
//   2. Send batch1 (3 messages) on the healthy connection.
//   3. Wait for the driver to fire dropAll on the server. Plugin sees WS
//      close; the lifecycle onDisconnected callback runs. Inside that
//      callback we submit batch2 (5 messages) -- the WS is in CLOSED state,
//      so each submit's send() throws a parkable NetworkError and the
//      OutboundQueue parks the item.
//   4. lifecycle.scheduleReconnect succeeds on its 1s backoff (server stays
//      listening for new connections). markAuthenticated fires onAuth ->
//      OutboundQueue.drain() -> the 5 parked items send and resolve.
//   5. Emit 'final' with the per-batch fulfillment counts and exit.
//
// Verifies the path-A parking branch (send-while-disconnected) over a real
// docker bridge network, with two separate processes and a real OS-level
// socket between them.

import { WsClient, ConnectionLifecycle } from '../../src/ws-client'
import { OutboundQueue } from '../../src/outbound-queue'
import type { TrueConfAccountConfig, Logger, TrueConfResponse } from '../../src/types'

const TARGET_HOST = process.env.TARGET_HOST ?? '127.0.0.1'
const FAKE_PORT = Number(process.env.FAKE_PORT ?? 4309)

interface Event {
  event: string
  [k: string]: unknown
}

function emit(obj: Event): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const logger: Logger = {
  info: (msg: string) => emit({ event: 'log', level: 'info', msg }),
  warn: (msg: string) => emit({ event: 'log', level: 'warn', msg }),
  error: (msg: string) => emit({ event: 'log', level: 'error', msg }),
  debug: () => undefined,
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const config: TrueConfAccountConfig = {
    serverUrl: TARGET_HOST,
    username: 'bot@srv',
    password: 'secret',
    useTls: false,
    port: FAKE_PORT,
  }

  const wsClient = new WsClient({})
  wsClient.logger = logger
  const outboundQueue = new OutboundQueue(wsClient, logger)

  let batch2Promises: Promise<TrueConfResponse>[] | null = null
  let batch2SubmittedResolve!: () => void
  const batch2SubmittedPromise = new Promise<void>((r) => { batch2SubmittedResolve = r })

  const lifecycle = new ConnectionLifecycle(wsClient, config, logger, {
    onConnected: () => emit({ event: 'connected' }),
    onDisconnected: () => {
      emit({ event: 'disconnected' })
      if (batch2Promises === null) {
        batch2Promises = [0, 1, 2, 3, 4].map((i) =>
          outboundQueue.submit('sendMessage', { chatId: 'C1', content: { text: `B2-${i}` } }),
        )
        emit({ event: 'batch2_submitted' })
        batch2SubmittedResolve()
      }
    },
    onConnectionClosed: (code, reason) => emit({ event: 'connection_closed', code, reason }),
    onTerminalFailure: (terminal) => {
      emit({ event: 'terminal_failure', kind: terminal.kind })
      outboundQueue.failAll(terminal.cause)
    },
  })

  // Lifecycle's reconnectTimer is unref'd, and parked OutboundQueue items
  // are pure Promises with no underlying handle. After dropAll the WS socket
  // is closed (no active handle either), so Node would exit early. Keep one
  // active handle alive for the duration of the scenario.
  const keepalive = setInterval(() => undefined, 1000)

  try {
    await lifecycle.start()
  } catch (err) {
    emit({ event: 'initial_connect_failed', err: err instanceof Error ? err.message : String(err) })
    clearInterval(keepalive)
    process.exit(1)
  }
  emit({ event: 'lifecycle_started' })

  emit({ event: 'batch1_start' })
  const batch1 = await Promise.allSettled([
    outboundQueue.submit('sendMessage', { chatId: 'C1', content: { text: 'B1-1' } }),
    outboundQueue.submit('sendMessage', { chatId: 'C1', content: { text: 'B1-2' } }),
    outboundQueue.submit('sendMessage', { chatId: 'C1', content: { text: 'B1-3' } }),
  ])
  emit({
    event: 'batch1_done',
    fulfilled: batch1.filter((s) => s.status === 'fulfilled').length,
    rejected: batch1.filter((s) => s.status === 'rejected').length,
  })

  // Driver fires dropAll here. lifecycle.onDisconnected submits batch2 inside
  // the close callback so each item hits the WS-not-connected throw path
  // before the next scheduleReconnect cycle resets the auth barrier.
  await batch2SubmittedPromise

  const batch2 = await Promise.allSettled(batch2Promises!)
  emit({
    event: 'batch2_done',
    fulfilled: batch2.filter((s) => s.status === 'fulfilled').length,
    rejected: batch2.filter((s) => s.status === 'rejected').length,
    rejections: batch2
      .map((s, i) => (s.status === 'rejected' ? { i, err: String((s as PromiseRejectedResult).reason) } : null))
      .filter((x) => x !== null),
  })

  emit({
    event: 'final',
    batch1Fulfilled: batch1.filter((s) => s.status === 'fulfilled').length,
    batch2Fulfilled: batch2.filter((s) => s.status === 'fulfilled').length,
  })

  lifecycle.shutdown()
  await sleep(300)
  clearInterval(keepalive)
  process.exit(0)
}

main().catch((err) => {
  emit({ event: 'fatal', err: err instanceof Error ? err.stack ?? err.message : String(err) })
  process.exit(1)
})
