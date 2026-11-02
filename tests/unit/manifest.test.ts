import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function loadManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync('openclaw.plugin.json', 'utf8')) as Record<string, unknown>
}

function getSchema(): Record<string, unknown> {
  const manifest = loadManifest()
  const channelConfigs = manifest.channelConfigs as Record<string, unknown>
  const trueconf = channelConfigs.trueconf as Record<string, unknown>
  return trueconf.schema as Record<string, unknown>
}

function getAccountsItemSchema(): Record<string, unknown> {
  const schema = getSchema()
  const properties = schema.properties as Record<string, Record<string, unknown>>
  const accounts = properties.accounts
  return accounts.additionalProperties as Record<string, unknown>
}

describe('openclaw.plugin.json', () => {
  it('carries the same version as package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(loadManifest().version).toBe(pkg.version)
  })

  // ClawHub requires openclaw.build.openclawVersion: the OpenClaw the package
  // is built against, which is the locked devDependency (CI's latest job
  // installs another one with --no-save, so read the lockfile, not node_modules).
  it('records the locked OpenClaw as openclaw.build.openclawVersion', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      openclaw: { build: { openclawVersion: string } }
    }
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, { version: string }>
    }
    expect(pkg.openclaw.build.openclawVersion).toBe(lock.packages['node_modules/openclaw'].version)
  })

  it('uses only manifest fields ClawHub accepts for a channel plugin', () => {
    const manifest = loadManifest()
    expect(manifest).toMatchObject({ id: 'trueconf', name: 'TrueConf', categories: ['channels'] })
    expect(manifest).not.toHaveProperty('label')
    expect(manifest).not.toHaveProperty('blurb')
    expect(manifest).not.toHaveProperty('minOpenClawVersion')
  })

  it('declares channel config metadata for TrueConf', () => {
    const manifest = loadManifest()
    const channelConfigs = manifest.channelConfigs as Record<string, unknown> | undefined
    const trueconf = channelConfigs?.trueconf as Record<string, unknown> | undefined
    const schema = trueconf?.schema as Record<string, unknown> | undefined

    expect(manifest.channels).toContain('trueconf')
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
    expect(schema?.properties).toMatchObject({
      serverUrl: { type: 'string' },
      username: { type: 'string' },
      useTls: { type: 'boolean' },
      accounts: { type: 'object' },
    })
  })

  // Schema landed in PR #7 with additionalProperties:false but listed only
  // the pre-v1.0 surface. groupAlwaysRespondIn (v1.1.0 / PR #6), tlsVerify
  // and setupLocale (PR #8) were silently rejected, breaking real configs
  // at gateway startup with "must NOT have additional properties". Lock the
  // full surface here so any future field that ships in src/types.ts has to
  // land in the manifest schema too.
  it('top-level schema accepts groupAlwaysRespondIn (PR #6)', () => {
    const properties = getSchema().properties as Record<string, unknown>
    expect(properties).toHaveProperty('groupAlwaysRespondIn')
    expect(properties.groupAlwaysRespondIn).toMatchObject({ type: 'array' })
  })

  it('top-level schema accepts tlsVerify (PR #8)', () => {
    const properties = getSchema().properties as Record<string, unknown>
    expect(properties).toHaveProperty('tlsVerify')
    expect(properties.tlsVerify).toMatchObject({ type: 'boolean' })
  })

  it('top-level schema accepts setupLocale (PR #8)', () => {
    const properties = getSchema().properties as Record<string, unknown>
    expect(properties).toHaveProperty('setupLocale')
    expect(properties.setupLocale).toMatchObject({ type: 'string', enum: ['en', 'ru'] })
  })

  it('per-account schema accepts tlsVerify (PR #8)', () => {
    const itemSchema = getAccountsItemSchema()
    const properties = itemSchema.properties as Record<string, unknown>
    expect(properties).toHaveProperty('tlsVerify')
    expect(properties.tlsVerify).toMatchObject({ type: 'boolean' })
  })

  it('per-account schema accepts setupLocale (PR #8)', () => {
    const itemSchema = getAccountsItemSchema()
    const properties = itemSchema.properties as Record<string, unknown>
    expect(properties).toHaveProperty('setupLocale')
    expect(properties.setupLocale).toMatchObject({ type: 'string', enum: ['en', 'ru'] })
  })
})

// The README install commands name an exact version so `openclaw plugins
// install` and `npx ... trueconf-setup` run the same, reviewed release. The
// release commit bumps package.json; this keeps the READMEs in step.
describe('README install commands', () => {
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version

  it.each(['README.md', 'README-ru.md'])('%s pins every install and setup command to package.json version', (file) => {
    const commands = readFileSync(file, 'utf8').match(/(?:openclaw plugins install|npx -y -p)[^\n`]*/g) ?? []
    const packageCommands = commands.filter((c) => c.includes('@trueconf-community/trueconf-openclaw-channel'))
    expect(packageCommands.length).toBeGreaterThan(0)
    for (const command of packageCommands) {
      expect(command).toContain(`@trueconf-community/trueconf-openclaw-channel@${version}`)
    }
  })
})
