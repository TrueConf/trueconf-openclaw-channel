import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isEphemeralPluginHostDir, isTrueconfInstalled, registerLoadPathIfMissing } from '../../bin/trueconf-setup.mjs'

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

describe('isTrueconfInstalled', () => {
  it('true when plugins.installs.trueconf is recorded in the config (openclaw <= 2026.4.x)', () => {
    const cfg = { plugins: { installs: { trueconf: {} } } }
    expect(isTrueconfInstalled(cfg, '/nonexistent/openclaw.json')).toBe(true)
  })

  it('true when extensions/trueconf exists next to the config (2026.6.x tarball install)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'tc-state-'))
    try {
      mkdirSync(join(stateDir, 'extensions', 'trueconf'), { recursive: true })
      expect(isTrueconfInstalled({}, join(stateDir, 'openclaw.json'))).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('true when npm/projects/<pkg>-<hash> exists next to the config (2026.6.x registry install)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'tc-state-'))
    try {
      mkdirSync(join(stateDir, 'npm', 'projects', 'trueconf-community-trueconf-openclaw-channel-d120d8b679'), { recursive: true })
      expect(isTrueconfInstalled({}, join(stateDir, 'openclaw.json'))).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('does NOT match unrelated npm/projects dirs', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'tc-state-'))
    try {
      mkdirSync(join(stateDir, 'npm', 'projects', 'some-other-plugin-abc123'), { recursive: true })
      expect(isTrueconfInstalled({}, join(stateDir, 'openclaw.json'))).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('true for plugins.entries.trueconf alone (2026.6.x registry installs leave nothing else in the raw config)', () => {
    const cfg = { plugins: { entries: { trueconf: { enabled: true } } } }
    expect(isTrueconfInstalled(cfg, '/nonexistent/openclaw.json')).toBe(true)
  })

  it('false when there is no install evidence at all', () => {
    expect(isTrueconfInstalled({}, '/nonexistent/openclaw.json')).toBe(false)
  })

  it('false for a missing or non-string configPath without throwing', () => {
    expect(isTrueconfInstalled({}, undefined)).toBe(false)
    expect(isTrueconfInstalled(undefined, undefined)).toBe(false)
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

  it('no-ops when extensions/trueconf exists next to the config', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'tc-state-'))
    const hostDir = mkdtempSync(join(tmpdir(), 'tc-host-'))
    try {
      mkdirSync(join(stateDir, 'extensions', 'trueconf'), { recursive: true })
      const cfg = { plugins: {} }
      const out = registerLoadPathIfMissing(cfg, hostDir, join(stateDir, 'openclaw.json'))
      expect(out.changed).toBe(false)
      expect(out.cfg).toEqual(cfg)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(hostDir, { recursive: true, force: true })
    }
  })
})
