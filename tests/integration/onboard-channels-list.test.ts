// Real integration test against openclaw 2026.4.21 sandboxed at /tmp/openclaw-repro/.
//
// Reproduces the COMPAT-07 bug surface end-to-end by spawning the actual
// openclaw 2026.4.21 binary and exercising `channels list`. Pre-fix, the
// runtime crashed with `TypeError: listAccountIds is not a function` because
// the call site at onboard-channels-DL-dId1s.js:192 + :604 reads
// `plugin.config.listAccountIds` on the loaded plugin, and our setup-only
// entry returned `{id, meta, setupWizard}` — undefined config.
//
// Post-fix (Plan 01-02 Task .3), setup-entry wraps createTrueconfPluginBase
// → full ChannelPlugin shape ships through the setup-only entry path.
//
// This test invokes the real openclaw binary against an isolated profile
// directory so the user's actual openclaw config is untouched. Channels list
// is the single offline-safe code path (no gateway required) that exercises
// plugin.config.{listAccountIds, defaultAccountId, resolveAccount, ...} via
// the runtime's actual call graph.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPRO_DIR = '/tmp/openclaw-repro'
const OPENCLAW_BIN = `${REPRO_DIR}/node_modules/.bin/openclaw`
const sandboxAvailable = existsSync(OPENCLAW_BIN)

describe.skipIf(!sandboxAvailable)('integration: openclaw 2026.4.21 channels list runtime', () => {
  // openclaw 2026.4.21's --profile flag isolates state under ~/.openclaw-<name>;
  // env vars OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR are documented but only
  // honored when the profile dir already exists. Use --profile with a unique
  // name and seed the dir directly. afterAll removes it. Random suffix avoids
  // collisions when this test file runs in parallel with itself in dev.
  const profileName = `tc-test-channels-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const profileDir = join(homedir(), `.openclaw-${profileName}`)

  // openclaw boot + channels list inspection is ~15-25s on a warm cache; spawn
  // once in beforeAll and run all assertions on the cached result. Saves ~40s
  // vs spawning per-it().
  let stdout = ''
  let stderr = ''
  let status: number | null = null

  beforeAll(() => {
    mkdirSync(profileDir, { recursive: true })
    const pluginRealpath = realpathSync(join(__dirname, '..', '..'))
    writeFileSync(
      join(profileDir, 'openclaw.json'),
      JSON.stringify({
        plugins: { load: { paths: [pluginRealpath] } },
        channels: {
          trueconf: {
            enabled: true,
            serverUrl: 'tc.example.com',
            username: 'integration-bot',
            password: 'integration-secret',
            useTls: true,
            port: 443,
          },
        },
      }, null, 2),
    )
    // Strip vitest worker env vars before invoking openclaw — openclaw's CLI
    // detects test-runner contexts and short-circuits some output. We need a
    // clean CLI invocation. Also strip CI=true (vitest sets it under some
    // configurations) so openclaw treats this as a normal interactive-ish run.
    const cleanEnv = { ...process.env }
    for (const k of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'CI', 'NODE_OPTIONS']) {
      delete cleanEnv[k]
    }
    try {
      stdout = execFileSync(OPENCLAW_BIN, ['--profile', profileName, 'channels', 'list'], {
        cwd: REPRO_DIR,
        env: cleanEnv,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      status = 0
    } catch (err) {
      const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number; message?: string }
      stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? '')
      stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? e.message ?? '')
      status = e.status ?? null
    }
  }, 90_000)

  afterAll(() => {
    rmSync(profileDir, { recursive: true, force: true })
  })

  it('channels list exits 0', () => {
    expect(status).toBe(0)
  })

  it('does NOT throw TypeError: listAccountIds is not a function', () => {
    // Call site at onboard-channels-DL-dId1s.js:604 reads plugin.config.listAccountIds(cfg).
    // Pre-fix surface returned undefined config → TypeError. Post-fix: full ChannelPlugin shape.
    expect(stderr).not.toMatch(/TypeError.*listAccountIds/)
    expect(stderr).not.toMatch(/Cannot read properties of undefined.*listAccountIds/)
  })

  it('does NOT crash on plugin.config.defaultAccountId access', () => {
    // Call site at onboard-channels-DL-dId1s.js:192 reads
    // plugin.config.defaultAccountId?.(cfg). Optional-chained so undefined
    // doesn't throw — but a wider undefined-config crash would surface here.
    expect(stderr).not.toMatch(/Cannot read properties of undefined/)
  })

  it('lists the configured TrueConf account as configured + enabled', () => {
    // openclaw channels list prints "- <Label> <accountId>: configured, enabled".
    // Our plugin labels itself "TrueConf" and the only configured account is "default".
    expect(stdout).toMatch(/TrueConf\s+default:\s*configured,\s*enabled/)
  })
})
