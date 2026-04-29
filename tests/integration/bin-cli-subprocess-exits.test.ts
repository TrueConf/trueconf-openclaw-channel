import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'

// Subprocess-level coverage for the bin/trueconf-setup.mjs CLI entry block
// (`if (isCliEntry) { ... }`). The other integration tests dynamic-import the
// module and call runSetup directly, which bypasses that block — so the
// switch from `process.exit(0)` to `process.exitCode = 0` (workaround for
// nodejs/node#56645's libuv assertion on Windows) needs subprocess coverage
// to catch a loop-hang regression on any platform.

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const BIN_PATH = join(REPO_ROOT, 'bin', 'trueconf-setup.mjs')
// Hard kill budget: clearly hung if we hit it. Per-test elapsed assertions
// below are tighter (2-3s) so a partial leak — say a 5-second timer ref —
// fails loud instead of squeaking under the kill budget.
const HARD_KILL_MS = 8000

interface SpawnResult { code: number; elapsedMs: number }

// Ask the OS for a port, then close — the port is now closed on loopback and
// reliably returns ECONNREFUSED. Beats a hard-coded `1` which times out under
// CI firewalls that SYN-drop traffic to privileged closed ports and would
// mask a real loop-hang regression as a flake.
async function reserveClosedPort(): Promise<number> {
  return await new Promise<number>((resolveExit, rejectExit) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectExit)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr !== 'object' || addr === null) {
        server.close()
        rejectExit(new Error('server.address() did not return an AddressInfo'))
        return
      }
      const { port } = addr
      server.close(() => resolveExit(port))
    })
  })
}

async function runCli(env: NodeJS.ProcessEnv, fakeHome: string): Promise<SpawnResult> {
  const start = Date.now()
  return await new Promise<SpawnResult>((resolveExit, rejectExit) => {
    // HOME (POSIX) and USERPROFILE (Windows) redirect os.homedir() — that's
    // how the wizard's `join(homedir(), '.openclaw', 'openclaw.json')` default
    // gets sandboxed to fakeHome instead of the real ~/.openclaw. The CLI
    // entry block does NOT parse --config from argv (separate gap, out of
    // scope here), so HOME is the only safe sandbox knob.
    const child = spawn(process.execPath, [BIN_PATH], {
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ...env },
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectExit(new Error(
        `CLI did not exit within ${HARD_KILL_MS}ms — likely a leaked event-loop handle. ` +
        `nodejs/node#56645 workaround removed process.exit() and relies on ` +
        `validateOAuthCredentials closing its undici dispatcher.`,
      ))
    }, HARD_KILL_MS)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveExit({ code: code ?? -1, elapsedMs: Date.now() - start })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      rejectExit(err)
    })
  })
}

describe('bin/trueconf-setup.mjs CLI subprocess', () => {
  it('exits 0 quickly on a successful headless run (no process.exit)', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server')
    const fake = await startFakeServer({ oauthResponse: { status: 200, body: { access_token: 'ok' } } })
    const fakeHome = mkdtempSync(join(tmpdir(), 'tc-cli-exit-success-'))
    try {
      const result = await runCli(
        {
          TRUECONF_SERVER_URL: fake.host,
          TRUECONF_USERNAME: 'bot@srv',
          TRUECONF_PASSWORD: 'secret',
          TRUECONF_USE_TLS: 'false',
          TRUECONF_PORT: String(fake.port),
        },
        fakeHome,
      )
      expect(result.code).toBe(0)
      // Tight budget: cold Node start + jiti load + one local fetch + write
      // should complete well under 3s on dev laptops and GitHub runners. A
      // future leaked timer (sharp libvips worker, AbortSignal.timeout that
      // forgot to .unref()) would push past this long before the hard kill.
      expect(result.elapsedMs).toBeLessThan(3000)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
      await stopFakeServer(fake)
    }
  }, HARD_KILL_MS + 4000)

  it('exits 1 quickly on OAuth failure (no process.exit)', async () => {
    const port = await reserveClosedPort()
    const fakeHome = mkdtempSync(join(tmpdir(), 'tc-cli-exit-failure-'))
    try {
      const result = await runCli(
        {
          TRUECONF_SERVER_URL: '127.0.0.1',
          TRUECONF_USERNAME: 'x',
          TRUECONF_PASSWORD: 'x',
          TRUECONF_USE_TLS: 'false',
          TRUECONF_PORT: String(port),
        },
        fakeHome,
      )
      expect(result.code).toBe(1)
      // ECONNREFUSED to a closed loopback port is sub-millisecond; node start
      // dominates. Same partial-leak rationale as the success case.
      expect(result.elapsedMs).toBeLessThan(3000)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  }, HARD_KILL_MS + 4000)
})
