import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NPX_HOST = '/home/u/.npm/_npx/deadbeef/node_modules/@trueconf-community/trueconf-openclaw-channel'
const HALT = 'TEST_HALT'

function haltPrompter() {
  const halt = () => { throw new Error(HALT) }
  return {
    intro: async () => {}, outro: async () => {}, note: async () => {},
    text: halt, password: halt, confirm: halt, select: halt, multiselect: halt,
    progress: () => ({ update: () => {}, stop: () => {} }),
  }
}

describe('bin: npx-cache ephemeral-host gate', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-gate-'))
    configPath = join(tmpDir, 'openclaw.json')
    delete process.env.TRUECONF_SETUP_LOCALE
    delete process.env.TRUECONF_SERVER_URL
    delete process.env.TRUECONF_USERNAME
    delete process.env.TRUECONF_PASSWORD
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TRUECONF_SETUP_LOCALE
    delete process.env.TRUECONF_SERVER_URL
    delete process.env.TRUECONF_USERNAME
    delete process.env.TRUECONF_PASSWORD
    delete process.env.TRUECONF_USE_TLS
    delete process.env.TRUECONF_PORT
  })

  it('fails fast (before creds) when host is npx-cache and plugin is not installed', async () => {
    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; pluginHostDir: string; prompter: unknown }) => Promise<void>
    }
    let caught: any
    await runSetup({ configPath, pluginHostDir: NPX_HOST, prompter: haltPrompter() }).catch((e) => { caught = e })

    expect(caught).toBeDefined()
    expect(caught.message).not.toContain(HALT)
    expect(caught.message).toContain('openclaw plugins install @trueconf-community/trueconf-openclaw-channel')
    expect(caught.message).toContain(NPX_HOST)
    expect(caught.userFacing).toBe(true)
    expect(existsSync(configPath)).toBe(false)
  })

  it('does NOT fire when extensions/trueconf exists next to the config (openclaw 2026.6.x layout)', async () => {
    // 2026.6.x keeps install records in the plugin index, not in openclaw.json:
    // after `openclaw plugins install` the raw config only has plugins.entries
    // while the package lives in <state-dir>/extensions/trueconf. The gate must
    // accept that layout, otherwise the documented install -> npx-setup order
    // dead-ends with "plugin is not installed" on a machine where it is.
    mkdirSync(join(tmpDir, 'extensions', 'trueconf'), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ plugins: { entries: { trueconf: { enabled: true } } } }, null, 2))
    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; pluginHostDir: string; prompter: unknown }) => Promise<void>
    }
    let caught: any
    await runSetup({ configPath, pluginHostDir: NPX_HOST, prompter: haltPrompter() }).catch((e) => { caught = e })

    expect(caught).toBeDefined()
    expect(caught.message).toContain(HALT)
  })

  it('does NOT fire when plugins.installs.trueconf is present (passes gate into creds)', async () => {
    writeFileSync(configPath, JSON.stringify({ plugins: { installs: { trueconf: {} } } }, null, 2))
    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; pluginHostDir: string; prompter: unknown }) => Promise<void>
    }
    let caught: any
    await runSetup({ configPath, pluginHostDir: NPX_HOST, prompter: haltPrompter() }).catch((e) => { caught = e })

    expect(caught).toBeDefined()
    expect(caught.message).toContain(HALT)
  })

  it('fails fast on the HEADLESS path too (creds set, gate precedes runHeadlessFinalize)', async () => {
    // hasSetupShortcut() is true here, so without the gate the headless branch
    // would run runHeadlessFinalize and silently write the bad path. The gate
    // sits before that branch, so it must still throw and write nothing.
    process.env.TRUECONF_SERVER_URL = '127.0.0.1'
    process.env.TRUECONF_USERNAME = 'x'
    process.env.TRUECONF_PASSWORD = 'x'
    process.env.TRUECONF_USE_TLS = 'false'
    process.env.TRUECONF_PORT = '1'
    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; pluginHostDir: string; prompter: unknown }) => Promise<void>
    }
    let caught: any
    await runSetup({ configPath, pluginHostDir: NPX_HOST, prompter: haltPrompter() }).catch((e) => { caught = e })

    expect(caught).toBeDefined()
    expect(caught.userFacing).toBe(true)
    expect(caught.message).toContain('openclaw plugins install @trueconf-community/trueconf-openclaw-channel')
    expect(existsSync(configPath)).toBe(false)
  })

  it('is not masked by an invalid TRUECONF_SETUP_LOCALE (gate beats locale validation)', async () => {
    // An invalid locale makes readSetupLocale() throw; the gate is the higher-
    // priority failure and must surface first (not the locale error).
    process.env.TRUECONF_SETUP_LOCALE = 'de'
    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; pluginHostDir: string; prompter: unknown }) => Promise<void>
    }
    let caught: any
    await runSetup({ configPath, pluginHostDir: NPX_HOST, prompter: haltPrompter() }).catch((e) => { caught = e })

    expect(caught).toBeDefined()
    expect(caught.userFacing).toBe(true)
    expect(caught.message).toContain('openclaw plugins install @trueconf-community/trueconf-openclaw-channel')
    expect(existsSync(configPath)).toBe(false)
  })
})
