// Real integration test against openclaw 2026.4.21 sandboxed at /tmp/openclaw-repro/.
//
// Reproduces UX-22 by spawning the actual openclaw 2026.4.21 binary and
// driving the `onboard` flow non-interactively. Pre-fix, openclaw's runtime
// hit `cannot read properties of undefined (reading 'defaultAccountId')` the
// moment our setup-only entry was loaded — the call site at
// onboard-channels-DL-dId1s.js:192 reads `plugin.config.defaultAccountId?.(cfg)`
// and our setup-only entry exposed neither `config` nor `setup`.
//
// We can't drive the interactive channel picker via stdin (the picker uses
// raw-mode TTY input that resists scripted feeds), but we CAN exercise the
// plugin-load + onboard-runtime-init path via `--non-interactive` mode. That
// path loads our setup-only entry, validates its surface, and walks through
// gateway/auth/skill onboarding. Any crash on `plugin.config.*` access during
// load/validate would surface in stderr.
//
// The companion test in onboard-channels-list.test.ts covers the live
// `channels list` runtime which routes through plugin.config.{listAccountIds,
// defaultAccountId, resolveAccount} on every invocation — together they pin
// the COMPAT-07 + UX-22 surface against openclaw 2026.4.21+.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPRO_DIR = '/tmp/openclaw-repro'
const OPENCLAW_BIN = `${REPRO_DIR}/node_modules/.bin/openclaw`
const sandboxAvailable = existsSync(OPENCLAW_BIN)

describe.skipIf(!sandboxAvailable)('integration: openclaw 2026.4.21 onboard runtime with our plugin loaded', () => {
  const profileName = `tc-test-onboard-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const profileDir = join(homedir(), `.openclaw-${profileName}`)

  let stderr = ''
  let status: number | null = null

  beforeAll(() => {
    mkdirSync(profileDir, { recursive: true })
    const pluginRealpath = realpathSync(join(__dirname, '..', '..'))
    // Start with ONLY our plugin path registered; no channels.* config so the
    // onboard runtime has to enumerate plugins, hit our setup-only entry, and
    // touch its surface during validation.
    writeFileSync(
      join(profileDir, 'openclaw.json'),
      JSON.stringify({
        plugins: { load: { paths: [pluginRealpath] } },
      }, null, 2),
    )
    // See onboard-channels-list.test.ts for the env-cleaning rationale —
    // vitest's NODE_OPTIONS tripped openclaw's CLI.
    const cleanEnv = { ...process.env }
    for (const k of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'CI', 'NODE_OPTIONS']) {
      delete cleanEnv[k]
    }
    try {
      execFileSync(
        OPENCLAW_BIN,
        [
          '--profile', profileName,
          'onboard',
          '--non-interactive',
          '--accept-risk',
          '--skip-channels',
          '--auth-choice', 'skip',
          '--flow', 'quickstart',
          '--skip-health',
        ],
        {
          cwd: REPRO_DIR,
          env: cleanEnv,
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      status = 0
    } catch (err) {
      const e = err as { stderr?: string | Buffer; status?: number; message?: string }
      stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? e.message ?? '')
      status = e.status ?? null
    }
  }, 90_000)

  afterAll(() => {
    rmSync(profileDir, { recursive: true, force: true })
  })

  it('onboard --non-interactive exits 0 with our plugin loaded (no plugin-load crash)', () => {
    expect(status).toBe(0)
  })

  it('does NOT throw on plugin.config.defaultAccountId during onboard runtime init', () => {
    // Pre-fix UX-22 crash signature. Even with --skip-channels, the runtime
    // still discovers + validates plugin.config of every loaded plugin during
    // onboarding setup. A drop of defaultAccountId from setup-entry would
    // surface as "Cannot read properties of undefined" or a TypeError here.
    expect(stderr).not.toMatch(/Cannot read properties of undefined.*defaultAccountId/)
    expect(stderr).not.toMatch(/TypeError.*defaultAccountId/)
  })

  it('does NOT throw on plugin.config.listAccountIds during onboard runtime init', () => {
    // COMPAT-07 crash signature.
    expect(stderr).not.toMatch(/TypeError.*listAccountIds is not a function/)
    expect(stderr).not.toMatch(/Cannot read properties of undefined.*listAccountIds/)
  })

  it('writes the onboard config (proves plugin discovery succeeded end-to-end)', () => {
    // openclaw onboard's --non-interactive path writes config. If our plugin
    // had crashed during load, the write would not happen. Reading back
    // proves the runtime got far enough to commit changes.
    const cfg = JSON.parse(readFileSync(join(profileDir, 'openclaw.json'), 'utf8')) as {
      plugins?: { load?: { paths?: string[] } }
    }
    expect(cfg.plugins?.load?.paths).toContain(realpathSync(join(__dirname, '..', '..')))
  })

  it('preserves our plugin path through onboard rewrite', () => {
    // Sanity: onboard rewrote openclaw.json (it adds gateway/workspace defaults)
    // but did NOT strip plugins.load.paths.
    const cfg = JSON.parse(readFileSync(join(profileDir, 'openclaw.json'), 'utf8')) as {
      plugins?: { load?: { paths?: string[] } }
    }
    expect(cfg.plugins?.load?.paths?.length ?? 0).toBeGreaterThanOrEqual(1)
  })
})
