import { describe, it, expect } from 'vitest'
import { isEphemeralPluginHostDir } from '../../bin/trueconf-setup.mjs'

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
