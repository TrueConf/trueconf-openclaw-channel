import { describe, it, expect } from 'vitest'
import { WsWorkerHandle } from '../../src/ws-worker-handle'
import type { TerminalCause, WsCoreConfig } from '../../src/ws-worker-protocol'
import { startFakeServer, waitFor, type FakeServer } from './fake-server'

function mkConfig(server: FakeServer): WsCoreConfig {
  return {
    account: {
      serverUrl: server.serverUrl,
      username: 'bot@srv',
      password: 'secret',
      useTls: false,
      port: server.port,
    },
  }
}

describe('ws-worker smoke', () => {
  it('end-to-end: spawn worker, connect to fake server, getChats round-trip', async () => {
    const server = await startFakeServer()
    server.chats.set([{ chatId: 'chat_alice@srv', title: 'Alice', chatType: 1 }])
    const handle = new WsWorkerHandle({
      accountId: 't1',
      config: mkConfig(server),
    })

    const authPromise = new Promise<string>((resolve) => handle.onAuth(resolve))
    await handle.start()
    const botUserId = await authPromise
    expect(botUserId).toBe('bot@srv')

    const res = await handle.sendRequest('getChats', { count: 100, page: 1 })
    expect(res).toBeDefined()
    expect(Array.isArray(res.payload)).toBe(true)
    expect((res.payload as Array<{ chatId: string }>)[0].chatId).toBe('chat_alice@srv')

    await handle.close()
    await server.close()
  }, 30_000)

  it('lag-injection: blocking main 5s does NOT drop WS connection', async () => {
    const server = await startFakeServer()
    const handle = new WsWorkerHandle({
      accountId: 't2',
      config: mkConfig(server),
    })
    const closes: number[] = []
    handle.onState = (s) => {
      if (s === 'reconnecting' || s === 'closed') closes.push(Date.now())
    }

    await handle.start()

    // Block main 5s with a busy-spin (simulates LLM/sharp CPU saturation that
    // wedges the event loop). Atomics.wait does not work on the main thread of
    // Node.js (TypeError), so a synchronous CPU-spin is what represents the
    // real bug scenario this test validates.
    const end = Date.now() + 5_000
    while (Date.now() < end) { /* spin */ }

    expect(closes).toHaveLength(0)
    const res = await handle.sendRequest('getChats', { count: 100, page: 1 })
    expect(res).toBeDefined()

    await handle.close()
    await server.close()
  }, 30_000)

  it('reconnect: server drops connection, worker reconnects', async () => {
    const server = await startFakeServer()
    const handle = new WsWorkerHandle({
      accountId: 't3',
      config: mkConfig(server),
    })
    const states: string[] = []
    handle.onState = (s) => states.push(s)

    await handle.start()

    expect(server.authRequests.length).toBeGreaterThanOrEqual(1)
    server.dropAll()

    await waitFor(() => states.includes('reconnecting'), 10_000)
    expect(states).toContain('reconnecting')

    await waitFor(() => server.authRequests.length >= 2, 10_000)
    expect(server.authRequests.length).toBeGreaterThanOrEqual(2)

    await handle.close()
    await server.close()
  }, 30_000)

  it('graceful shutdown: close() exits worker with terminal cause shutdown', async () => {
    const server = await startFakeServer()
    const handle = new WsWorkerHandle({
      accountId: 't4',
      config: mkConfig(server),
    })
    let terminalCause: TerminalCause | null = null
    handle.onTerminal = (c) => { terminalCause = c }

    await handle.start()
    await handle.close()

    expect(terminalCause).not.toBeNull()
    expect(terminalCause).toMatchObject({ kind: 'shutdown' })

    await server.close()
  }, 15_000)
})
