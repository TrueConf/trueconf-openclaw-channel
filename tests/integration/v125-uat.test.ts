import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ENV vars MUST be set before any import that pulls in src/ws-client.ts —
// HEARTBEAT_INTERVAL_MS / OAUTH_TIMEOUT_MS / OAUTH_FAIL_LIMIT etc. are
// frozen at module load (see plans 02-01..02-03 D-05). ES static imports are
// hoisted above plain top-level statements, so vi.hoisted is the only way to
// land these mutations BEFORE the src/* import graph evaluates. Vitest 4
// isolates test files into separate workers by default, so this only
// affects this file.
vi.hoisted(() => {
  process.env.TRUECONF_HEARTBEAT_INTERVAL_MS = '250'
  process.env.TRUECONF_HEARTBEAT_PONG_TIMEOUT_MS = '5000'
  process.env.TRUECONF_OAUTH_TIMEOUT_MS = '300'
  process.env.TRUECONF_WS_HANDSHAKE_TIMEOUT_MS = '5000'
  process.env.TRUECONF_OAUTH_FAIL_LIMIT = '2'
  process.env.TRUECONF_DNS_FAIL_LIMIT = '20'
})

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import type { WebSocket } from 'ws'
import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

interface Logger {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
}

interface Harness {
  abort: () => void
  startPromise: Promise<void>
  logger: Logger
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

async function bootPlugin(server: FakeServer, opts: { waitForConnection?: boolean } = {}): Promise<Harness> {
  const logger = makeLogger()
  const api = {
    logger,
    runtime: {},
    config: {
      channels: {
        trueconf: {
          serverUrl: server.serverUrl,
          port: server.port,
          useTls: false,
          username: 'bot@srv',
          password: 'secret',
          dmPolicy: 'open',
        },
      },
    },
    on: () => {},
  }
  registerFull(api as never)
  const ac = new AbortController()
  const startPromise = (channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>)({
    accountId: 'default',
    setStatus: () => {},
    abortSignal: ac.signal,
  })
  // Pre-attach a swallow so an unhandled rejection on a failing-boot test
  // doesn't trip vitest's unhandled-rejection guard.
  startPromise.catch(() => {})
  if (opts.waitForConnection !== false) {
    await waitFor(() => server.authRequests.length >= 1 && server.connections.size > 0, 5000)
  }
  return { abort: () => ac.abort(), startPromise, logger }
}

function loggedAt(logger: Logger, level: 'info' | 'warn' | 'error', substring: string): boolean {
  return logger[level].mock.calls.some((call) => String(call[0] ?? '').includes(substring))
}

describe('integration: v1.2.5 publish-blocker UAT', () => {
  let server: FakeServer
  let harness: Harness | null = null

  beforeEach(async () => {
    __resetForTesting()
    server = await startFakeServer()
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
  })

  // UAT 1 — TECH-DEBT-9 (item 35a): heartbeat ping cadence is ENV-tunable.
  // Drives a real WS connection through the fake bridge and counts ws ping
  // frames over a measurement window. With the override at 250ms, a 1.25s
  // window must observe at least 4 pings — the default 30s would yield zero.
  it('TRUECONF_HEARTBEAT_INTERVAL_MS controls ping cadence on the live WS', async () => {
    harness = await bootPlugin(server)

    let pingCount = 0
    for (const ws of server.connections as Set<WebSocket>) {
      ws.on('ping', () => { pingCount++ })
    }

    await waitFor(() => pingCount >= 4, 3000)
    expect(pingCount).toBeGreaterThanOrEqual(4)
  }, 10_000)

  // UAT 2 — TECH-DEBT-11 (item 34): consecutive 401s trip auth_exhausted
  // terminal lifecycle outcome. After successful boot, flip OAuth to 401
  // and drop the WS — the reconnect loop hits 2 consecutive 401s and emits
  // the D-08 log line, then stops scheduling further reconnects.
  it('rotated bot password triggers auth_exhausted after OAUTH_FAIL_LIMIT consecutive 401s', async () => {
    harness = await bootPlugin(server)
    const initialOauthCount = server.oauthRequests.length

    server.setOauthResponse({
      status: 401,
      body: { error: 'invalid_grant', error_description: 'bad creds' },
    })
    server.dropAll()

    await waitFor(
      () => loggedAt(harness!.logger, 'error', 'OAuth authentication failed') &&
            loggedAt(harness!.logger, 'error', 'Giving up'),
      15_000,
    )

    expect(server.oauthRequests.length - initialOauthCount).toBeGreaterThanOrEqual(2)
    const giveupCall = harness.logger.error.mock.calls.find((call) =>
      String(call[0]).includes('OAuth authentication failed') &&
      String(call[0]).includes('Giving up'),
    )
    expect(giveupCall).toBeDefined()
    // D-08 verbatim phrase: log names credentials check (defense against future
    // template-substitution refactors that might leak username/password).
    expect(String(giveupCall![0])).toMatch(/check bot credentials \(username\/password\)/)

    // Counter must be at exactly OAUTH_FAIL_LIMIT (=2) — bot didn't loop past terminal.
    expect(String(giveupCall![0])).toMatch(/failed 2 times/)

    // No further OAuth attempts after terminal (small grace window).
    const oauthAfterTerminal = server.oauthRequests.length
    await new Promise((r) => setTimeout(r, 500))
    expect(server.oauthRequests.length).toBe(oauthAfterTerminal)
  }, 20_000)

  // UAT 3 — TECH-DEBT-10 (item 35b) + 11 (D-07): a hung OAuth endpoint trips
  // AbortSignal.timeout on each attempt, which surfaces as
  // NetworkError(code='OAUTH_TIMEOUT'). isAuthTerminalError parses the code as
  // NaN via Number.isFinite guard, falls into the else branch, and resets
  // oauthFailCount=0 each cycle. Three timeouts must NOT trip auth_exhausted.
  it('OAUTH_TIMEOUT failures do not count toward the auth_exhausted threshold', async () => {
    harness = await bootPlugin(server)
    const initialOauthCount = server.oauthRequests.length

    server.setHangOauth(true)
    server.dropAll()

    // Each attempt: AbortSignal.timeout(300ms) + backoff (1s..2s..4s with jitter).
    // Three attempts ~7-10s; allow 25s for slow CI.
    await waitFor(
      () => server.oauthRequests.length - initialOauthCount >= 3,
      25_000,
    )

    expect(server.oauthRequests.length - initialOauthCount).toBeGreaterThanOrEqual(3)

    // Critical invariant: NO auth_exhausted terminal log line emitted despite
    // OAUTH_FAIL_LIMIT=2 — proves OAUTH_TIMEOUT classifies as transient, not auth-terminal.
    const giveupCall = harness.logger.error.mock.calls.find((call) =>
      String(call[0]).includes('OAuth authentication failed') &&
      String(call[0]).includes('Giving up'),
    )
    expect(giveupCall).toBeUndefined()

    // Timeout warnings should be present (lifecycle.warn on reconnect attempt failed).
    expect(loggedAt(harness.logger, 'warn', 'Reconnect attempt failed')).toBe(true)
  }, 30_000)
})
