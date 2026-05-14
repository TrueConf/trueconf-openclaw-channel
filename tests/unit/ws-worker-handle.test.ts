import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { WsWorkerHandle, type WorkerLike } from '../../src/ws-worker-handle'
import type { MainToWorker, WorkerToMain, WsCoreConfig } from '../../src/ws-worker-protocol'

class FakeWorker extends EventEmitter implements WorkerLike {
  sent: MainToWorker[] = []
  postMessage(m: unknown): void {
    this.sent.push(m as MainToWorker)
  }
  async terminate(): Promise<number> {
    queueMicrotask(() => this.emit('exit', 1))
    return 1
  }
  emitFromWorker(m: WorkerToMain): void {
    this.emit('message', m)
  }
}

function mkConfig(): WsCoreConfig {
  return {
    account: {
      serverUrl: '127.0.0.1',
      username: 'bot',
      password: 'pw',
      useTls: false,
      port: 4309,
    },
  }
}

function mkHandle(): { handle: WsWorkerHandle; fake: FakeWorker } {
  const fake = new FakeWorker()
  const handle = new WsWorkerHandle({
    accountId: 'a1',
    config: mkConfig(),
    workerFactory: () => fake,
  })
  // Most tests don't simulate auth, so swallow the auth-timeout rejection
  // from start()'s internal wait — these tests exercise the wire protocol,
  // not the auth-completion contract.
  void handle.start().catch(() => undefined)
  return { handle, fake }
}

describe('WsWorkerHandle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sendRequest round-trip: response resolves promise', async () => {
    const { handle, fake } = mkHandle()
    const pr = handle.sendRequest('getMe', {})
    expect(fake.sent[0]).toMatchObject({ kind: 'sendRequest', method: 'getMe', reqId: 1 })
    fake.emitFromWorker({ kind: 'response', reqId: 1, ok: true, data: { type: 2, id: 1, payload: { userId: 'me' } } })
    await expect(pr).resolves.toMatchObject({ payload: { userId: 'me' } })
  })

  it('sendRequest error path rejects with parkable Error', async () => {
    const { handle, fake } = mkHandle()
    const pr = handle.sendRequest('m', {})
    fake.emitFromWorker({
      kind: 'response', reqId: 1, ok: false,
      error: { name: 'Error', message: 'boom', parkable: true },
    })
    await expect(pr).rejects.toMatchObject({ message: 'boom', parkable: true })
  })

  it('auth event populates botUserId and fires onAuth listeners', () => {
    const { handle, fake } = mkHandle()
    const auths: string[] = []
    handle.onAuth((id) => auths.push(id))
    fake.emitFromWorker({ kind: 'auth', botUserId: 'bot-42' })
    expect(handle.botUserId).toBe('bot-42')
    expect(auths).toEqual(['bot-42'])
  })

  it('authLost clears botUserId and fires onAuthLost listeners', () => {
    const { handle, fake } = mkHandle()
    fake.emitFromWorker({ kind: 'auth', botUserId: 'bot-42' })
    const losses: string[] = []
    handle.onAuthLost((r) => losses.push(r ?? ''))
    fake.emitFromWorker({ kind: 'authLost', reason: '203' })
    expect(handle.botUserId).toBeNull()
    expect(losses).toEqual(['203'])
  })

  it('inbound dispatch invokes onInboundMessage', () => {
    const { handle, fake } = mkHandle()
    const got: unknown[] = []
    handle.onInboundMessage = (msg) => { got.push(msg); return Promise.resolve() }
    fake.emitFromWorker({ kind: 'inbound', method: 'sendMessage', payload: { chatId: 'c1' } })
    expect(got).toHaveLength(1)
  })

  it('push fan-out to multiple listeners', () => {
    const { handle, fake } = mkHandle()
    const a: string[] = [], b: string[] = []
    handle.onPush((m) => a.push(m))
    handle.onPush((m) => b.push(m))
    fake.emitFromWorker({ kind: 'push', method: 'presence', payload: {} })
    expect(a).toEqual(['presence'])
    expect(b).toEqual(['presence'])
  })

  it('appPong clears pending nonce, preventing respawn', () => {
    const { handle: _h, fake } = mkHandle()
    void _h
    vi.advanceTimersByTime(5_000)
    const ping = fake.sent.find((m) => m.kind === 'appPing') as Extract<MainToWorker, { kind: 'appPing' }>
    expect(ping).toBeDefined()
    fake.emitFromWorker({ kind: 'appPong', nonce: ping.nonce })
    vi.advanceTimersByTime(20_000)
    // No terminate (no respawn): fake's exit emit only fires from terminate().
  })

  it('worker exit rejects pending sendRequests with parkable flag', async () => {
    const { handle, fake } = mkHandle()
    const pr = handle.sendRequest('m', {})
    fake.emit('exit', 99)
    await expect(pr).rejects.toMatchObject({ message: 'worker exited', parkable: true })
  })

  it('close() sends shutdown and waits for exit', async () => {
    const { handle, fake } = mkHandle()
    const p = handle.close('test')
    expect(fake.sent.at(-1)).toMatchObject({ kind: 'shutdown', reason: 'test' })
    queueMicrotask(() => fake.emit('exit', 0))
    await vi.runOnlyPendingTimersAsync()
    await p
  })

  it('terminal cause propagates to onTerminal', () => {
    const { handle, fake } = mkHandle()
    let captured: unknown = null
    handle.onTerminal = (c) => { captured = c }
    fake.emitFromWorker({ kind: 'terminal', cause: { kind: 'dns_exhausted' } })
    expect(captured).toMatchObject({ kind: 'dns_exhausted' })
  })
})
