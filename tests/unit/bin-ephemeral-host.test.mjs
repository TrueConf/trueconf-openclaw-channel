import { describe, it, expect } from 'vitest'
import { isEphemeralPluginHostDir, registerLoadPathIfMissing } from '../../bin/trueconf-setup.mjs'

describe('isEphemeralPluginHostDir', () => {
  it('detects a POSIX npx cache path', () => {
    expect(isEphemeralPluginHostDir('/home/u/.npm/_npx/abc123/node_modules/@s/p')).toBe(true)
  })

  it('detects a Windows npx cache path', () => {
    expect(isEphemeralPluginHostDir('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@s\\p')).toBe(true)
  })

  it('returns true for a non-existent _npx path without throwing', () => {
    expect(isEphemeralPluginHostDir('/no/such/_npx/x/y')).toBe(true)
  })

  it('does NOT match _npx as a substring of a segment', () => {
    expect(isEphemeralPluginHostDir('/home/u/tools/my_npxthing/p')).toBe(false)
  })

  it('returns false for an installed extensions dir', () => {
    expect(isEphemeralPluginHostDir('/home/u/.openclaw/extensions/trueconf')).toBe(false)
  })

  it('returns false for a source checkout path', () => {
    expect(isEphemeralPluginHostDir('/home/u/src/trueconf-openclaw-channel')).toBe(false)
  })

  it('returns false for a non-string input', () => {
    expect(isEphemeralPluginHostDir(undefined)).toBe(false)
  })
})

// Lives here (not in bin-register-load-path.test.mjs) so it runs on Windows
// too: that suite's beforeAll creates a symlink, which throws EPERM without
// Developer Mode and skips the whole file. This case is a pure lexical check
// and needs no filesystem fixture.
describe('registerLoadPathIfMissing + npx-cache host', () => {
  it('refuses an npx-cache pluginHostDir (no-op, no throw)', () => {
    const cfg = { plugins: { load: { paths: ['/existing/plugin'] } } }
    const out = registerLoadPathIfMissing(cfg, '/home/u/.npm/_npx/abc/node_modules/@s/p')
    expect(out.changed).toBe(false)
    expect(out.cfg).toEqual(cfg)
  })
})
