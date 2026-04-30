import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFakeServer, stopFakeServer, type FakeServer } from '../smoke/fake-server'

// Subprocess coverage for `bin/trueconf-setup.mjs` argv parsing. The other
// integration tests dynamic-import the module and call runSetup directly,
// which bypasses the `if (isCliEntry) { ... }` block where parseArgs runs.
// These tests spawn the bin so the argv parse path is actually exercised.
//
// Sandbox via BOTH HOME and USERPROFILE per AGENTS.md §10 (Windows fallback):
// macOS reads HOME, Windows reads USERPROFILE — setting only one creates a
// Windows-CI footgun where a regression silently writes to the real user's
// ~/.openclaw/openclaw.json.

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const BIN_PATH = join(REPO_ROOT, 'bin', 'trueconf-setup.mjs')

interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

function spawnSetup(args: string[], env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((resolveProm, rejectProm) => {
    const proc = spawn(process.execPath, [BIN_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      rejectProm(new Error('CLI did not exit within 8s — likely a hang'))
    }, 8000)
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      resolveProm({ code: code ?? -1, stdout, stderr })
    })
    proc.on('error', (err) => {
      clearTimeout(killTimer)
      rejectProm(err)
    })
  })
}

describe('bin/trueconf-setup.mjs --config argv parsing', () => {
  let sandboxHome: string
  let fake: FakeServer

  beforeEach(async () => {
    sandboxHome = mkdtempSync(join(tmpdir(), 'trueconf-cli-config-'))
    fake = await startFakeServer({ oauthResponse: { status: 200, body: { access_token: 'ok' } } })
  })

  afterEach(async () => {
    await stopFakeServer(fake)
    rmSync(sandboxHome, { recursive: true, force: true })
  })

  function headlessEnv(): NodeJS.ProcessEnv {
    return {
      // Sandbox both HOME and USERPROFILE per AGENTS.md §10
      // (Windows-fallback safety; setting only one is a CI footgun).
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      // Headless wizard shortcut — no TTY prompts.
      TRUECONF_SERVER_URL: fake.host,
      TRUECONF_USERNAME: 'bot@srv',
      TRUECONF_PASSWORD: 'secret',
      TRUECONF_USE_TLS: 'false',
      TRUECONF_PORT: String(fake.port),
    }
  }

  it('--config <path> writes to that path; default HOME path is NOT created', async () => {
    const customConfigPath = join(sandboxHome, 'custom.json')
    const result = await spawnSetup(['--config', customConfigPath], headlessEnv())

    expect(result.code).toBe(0)
    expect(existsSync(customConfigPath)).toBe(true)
    const written = JSON.parse(readFileSync(customConfigPath, 'utf8'))
    expect(written.channels?.trueconf?.username).toBe('bot@srv')

    // Critical: the default HOME-based path must NOT exist when --config
    // routes the wizard output elsewhere.
    const defaultPath = join(sandboxHome, '.openclaw', 'openclaw.json')
    expect(existsSync(defaultPath)).toBe(false)
  })

  it('no argv flags → writes to default HOME-based path (preserves v1.2.x default behavior)', async () => {
    const result = await spawnSetup([], headlessEnv())

    expect(result.code).toBe(0)
    const defaultPath = join(sandboxHome, '.openclaw', 'openclaw.json')
    expect(existsSync(defaultPath)).toBe(true)
    const written = JSON.parse(readFileSync(defaultPath, 'utf8'))
    expect(written.channels?.trueconf?.username).toBe('bot@srv')
  })

  it('--unknown-flag fails loud with usage hint to stderr', async () => {
    const result = await spawnSetup(['--unknown-flag', 'value'], headlessEnv())

    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/Usage:/i)
    expect(result.stderr).toMatch(/unknown|--unknown-flag/i)
  })

  it('positional argument fails loud with usage hint to stderr', async () => {
    const customConfigPath = join(sandboxHome, 'should-not-be-positional.json')
    const result = await spawnSetup([customConfigPath], headlessEnv())

    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/Usage:/i)
    // node:util parseArgs throws with a message containing "positional".
    expect(result.stderr).toMatch(/positional|unexpected/i)
    // The file must NOT have been created (parse fails before runSetup).
    expect(existsSync(customConfigPath)).toBe(false)
  })

  it('--config without value fails loud', async () => {
    const result = await spawnSetup(['--config'], headlessEnv())

    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/Usage:|trueconf-setup:/i)
  })
})
