import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Subprocess-level coverage for the bin/trueconf-setup.mjs CLI entry block
// (`if (isCliEntry) { ... }`). The other integration tests dynamic-import the
// module and call runSetup directly, which bypasses that block — so the
// switch from `process.exit(0)` to `process.exitCode = 0` (workaround for
// nodejs/node#56645's libuv assertion on Windows) needs subprocess coverage
// to catch a loop-hang regression on any platform.

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const BIN_PATH = join(REPO_ROOT, 'bin', 'trueconf-setup.mjs')
const EXIT_BUDGET_MS = 8000

interface SpawnResult { code: number; elapsedMs: number }

async function runCli(env: NodeJS.ProcessEnv, configPath: string): Promise<SpawnResult> {
  const start = Date.now()
  return await new Promise<SpawnResult>((resolveExit, rejectExit) => {
    const child = spawn(process.execPath, [BIN_PATH, '--config', configPath], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectExit(new Error(
        `CLI did not exit within ${EXIT_BUDGET_MS}ms — likely a leaked event-loop handle. ` +
        `nodejs/node#56645 workaround removed process.exit() and relies on ` +
        `validateOAuthCredentials closing its undici dispatcher.`,
      ))
    }, EXIT_BUDGET_MS)
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
  it('exits 0 within the budget on a successful headless run (no process.exit)', async () => {
    const { startFakeServer, stopFakeServer } = await import('../smoke/fake-server')
    const fake = await startFakeServer({ oauthResponse: { status: 200, body: { access_token: 'ok' } } })
    const dir = mkdtempSync(join(tmpdir(), 'tc-cli-exit-success-'))
    try {
      const result = await runCli(
        {
          TRUECONF_SERVER_URL: fake.host,
          TRUECONF_USERNAME: 'bot@srv',
          TRUECONF_PASSWORD: 'secret',
          TRUECONF_USE_TLS: 'false',
          TRUECONF_PORT: String(fake.port),
        },
        join(dir, 'openclaw.json'),
      )
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await stopFakeServer(fake)
    }
  }, EXIT_BUDGET_MS + 4000)

  it('exits 1 within the budget on OAuth failure (no process.exit)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-cli-exit-failure-'))
    try {
      const result = await runCli(
        {
          TRUECONF_SERVER_URL: '127.0.0.1',
          TRUECONF_USERNAME: 'x',
          TRUECONF_PASSWORD: 'x',
          TRUECONF_USE_TLS: 'false',
          TRUECONF_PORT: '1',
        },
        join(dir, 'openclaw.json'),
      )
      expect(result.code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, EXIT_BUDGET_MS + 4000)
})
