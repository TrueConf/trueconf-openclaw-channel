import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
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
    expect(caught.userFacing).toBe(true)
    expect(existsSync(configPath)).toBe(false)
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
})
