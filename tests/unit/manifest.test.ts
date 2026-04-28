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
