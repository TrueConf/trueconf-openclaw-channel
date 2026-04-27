import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function loadManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync('openclaw.plugin.json', 'utf8')) as Record<string, unknown>
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
})
