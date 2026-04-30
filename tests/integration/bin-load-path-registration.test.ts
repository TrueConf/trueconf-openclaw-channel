import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// REPO_ROOT mirrors bin/trueconf-setup.mjs:16 — parent of bin/. From this test
// file (tests/integration/X.test.ts), three `..` jumps reach the repo root.
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

describe('bin/trueconf-setup.mjs runSetup auto-registers plugins.load.paths', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trueconf-loadpath-'))
    configPath = join(tmpDir, 'openclaw.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TRUECONF_SERVER_URL
    delete process.env.TRUECONF_USERNAME
    delete process.env.TRUECONF_PASSWORD
    delete process.env.TRUECONF_USE_TLS
    delete process.env.TRUECONF_PORT
  })

  async function setupHeadlessEnv() {
    const { startFakeServer } = await import('../smoke/fake-server') as never
    const fake = await (startFakeServer as (opts: unknown) => Promise<{ host: string; port: number }>)(
      { oauthResponse: { status: 200, body: { access_token: 'ok' } } },
    )
    process.env.TRUECONF_SERVER_URL = fake.host
    process.env.TRUECONF_USERNAME = 'bot@localhost'
    process.env.TRUECONF_PASSWORD = 'secret'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = String(fake.port)
    return fake
  }

  async function teardownFake(fake: { host: string; port: number }) {
    const { stopFakeServer } = await import('../smoke/fake-server') as never
    await (stopFakeServer as (f: unknown) => Promise<void>)(fake)
  }

  it('appends realpath of REPO_ROOT to plugins.load.paths after first run', async () => {
    const fake = await setupHeadlessEnv()
    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string }) => Promise<unknown>
      }
      await runSetup({ configPath })

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        plugins?: { load?: { paths?: string[] } }
      }
      const expectedPath = realpathSync(REPO_ROOT)
      expect(written.plugins?.load?.paths).toContain(expectedPath)
    } finally {
      await teardownFake(fake)
    }
  })

  it('does NOT duplicate the entry when re-run', async () => {
    const fake = await setupHeadlessEnv()
    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string }) => Promise<unknown>
      }
      await runSetup({ configPath })
      await runSetup({ configPath })

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        plugins?: { load?: { paths?: string[] } }
      }
      const expectedPath = realpathSync(REPO_ROOT)
      const matches = (written.plugins?.load?.paths ?? []).filter((p) => p === expectedPath)
      expect(matches.length).toBe(1)
    } finally {
      await teardownFake(fake)
    }
  })

  it('skips registration when plugins.installs.trueconf is preset', async () => {
    const fake = await setupHeadlessEnv()
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          plugins: { installs: { trueconf: { path: '/already-registered' } } },
          meta: { lastTouchedVersion: '2026.4.30' },
        }, null, 2),
      )

      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string }) => Promise<unknown>
      }
      await runSetup({ configPath })

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
        plugins?: {
          installs?: { trueconf?: { path?: string } }
          load?: { paths?: string[] }
        }
      }
      expect(written.plugins?.installs?.trueconf?.path).toBe('/already-registered')
      const expectedPath = realpathSync(REPO_ROOT)
      const paths = written.plugins?.load?.paths ?? []
      expect(paths).not.toContain(expectedPath)
    } finally {
      await teardownFake(fake)
    }
  })

  it('emits exactly one "Registered plugin host at" console.info on first push', async () => {
    const fake = await setupHeadlessEnv()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
        runSetup: (opts: { configPath: string }) => Promise<unknown>
      }
      await runSetup({ configPath })

      const calls = infoSpy.mock.calls.flat().filter(
        (arg) => typeof arg === 'string' && arg.includes('Registered plugin host at'),
      )
      expect(calls.length).toBe(1)
      expect(calls[0]).toContain(realpathSync(REPO_ROOT))
    } finally {
      infoSpy.mockRestore()
      await teardownFake(fake)
    }
  })
})
