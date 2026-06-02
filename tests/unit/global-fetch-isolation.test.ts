import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici'
import { acquireToken } from '../../src/ws-client'
import { startFakeServer, type FakeServer } from '../smoke/fake-server'

describe('global-fetch-isolation', () => {
  let server: FakeServer
  let origFetch: typeof globalThis.fetch

  beforeEach(async () => {
    server = await startFakeServer()
    origFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = origFetch
    await server.close()
  })

  it('acquireToken bypasses broken globalThis.fetch (defensive isolation against host runtime)', async () => {
    const brokenFetch = vi.fn(() => {
      const cause = Object.assign(new Error('invalid onRequestStart method'), { code: 'UND_ERR_INVALID_ARG' })
      throw new TypeError('fetch failed', { cause })
    })
    globalThis.fetch = brokenFetch as unknown as typeof globalThis.fetch

    const tok = await acquireToken({
      serverUrl: server.serverUrl,
      port: server.port,
      useTls: false,
      username: 'bot@srv',
      password: 'secret',
    })

    expect(tok.access_token).toBe('TEST_TOKEN')
    expect(brokenFetch).not.toHaveBeenCalled()
  })

  it('acquireToken survives a broken global dispatcher (foreign-undici host runtime, e.g. Node 26 ships undici 8)', async () => {
    // The process-global dispatcher is an Agent from the host runtime's undici.
    // When that is a different major than the undici we bundle, routing our
    // fetch through it throws `UND_ERR_INVALID_ARG: invalid onRequestStart
    // method`. acquireToken must dispatch through an Agent from OUR undici and
    // never fall through to the global one.
    const orig = getGlobalDispatcher()
    const broken = {
      dispatch() {
        throw Object.assign(new Error('invalid onRequestStart method'), { code: 'UND_ERR_INVALID_ARG' })
      },
      close: async () => {},
      destroy: async () => {},
    } as unknown as Dispatcher
    setGlobalDispatcher(broken)
    try {
      const tok = await acquireToken({
        serverUrl: server.serverUrl,
        port: server.port,
        useTls: false,
        username: 'bot@srv',
        password: 'secret',
      })
      expect(tok.access_token).toBe('TEST_TOKEN')
    } finally {
      setGlobalDispatcher(orig)
    }
  })
})
