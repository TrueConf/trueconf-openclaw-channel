import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { registerLoadPathIfMissing } = await import('../../bin/trueconf-setup.mjs')

describe('registerLoadPathIfMissing', () => {
  let tmpRoot
  let realDir
  let symlinkDir

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'trueconf-load-path-'))
    realDir = join(tmpRoot, 'real-package')
    mkdirSync(realDir, { recursive: true })
    symlinkDir = join(tmpRoot, 'symlinked-package')
    symlinkSync(realDir, symlinkDir, 'dir')
  })

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('pushes pluginHostDir when cfg is empty', () => {
    const out = registerLoadPathIfMissing({}, realDir)
    expect(out.cfg.plugins.load.paths).toEqual([realpathSync(realDir)])
    expect(out.changed).toBe(true)
  })

  it('skips when plugins.installs.trueconf is set (any shape)', () => {
    const cfg = { plugins: { installs: { trueconf: { path: '/x' } } } }
    const out = registerLoadPathIfMissing(cfg, realDir)
    expect(out.cfg).toEqual(cfg)
    expect(out.changed).toBe(false)

    const cfg2 = { plugins: { installs: { trueconf: {} } } }
    const out2 = registerLoadPathIfMissing(cfg2, realDir)
    expect(out2.cfg).toEqual(cfg2)
    expect(out2.changed).toBe(false)
  })

  it('skips when load.paths already contains the realpath', () => {
    const cfg = { plugins: { load: { paths: [realpathSync(realDir)] } } }
    const out = registerLoadPathIfMissing(cfg, realDir)
    expect(out.cfg).toEqual(cfg)
    expect(out.changed).toBe(false)
  })

  it('skips when load.paths contains a symlink that resolves to the realpath', () => {
    const cfg = { plugins: { load: { paths: [symlinkDir] } } }
    const out = registerLoadPathIfMissing(cfg, realDir)
    expect(out.changed).toBe(false)
  })

  it('appends when load.paths exists but does NOT contain the realpath', () => {
    const cfg = { plugins: { load: { paths: ['/some/other/plugin'] } } }
    const out = registerLoadPathIfMissing(cfg, realDir)
    expect(out.cfg.plugins.load.paths).toEqual(['/some/other/plugin', realpathSync(realDir)])
    expect(out.changed).toBe(true)
  })

  it('creates nested structure when plugins exists but load is missing', () => {
    const cfg = { plugins: {} }
    const out = registerLoadPathIfMissing(cfg, realDir)
    expect(out.cfg.plugins.load.paths).toEqual([realpathSync(realDir)])
    expect(out.changed).toBe(true)
  })

  it('does NOT mutate the input cfg', () => {
    const cfg = { plugins: { load: { paths: ['/x'] } } }
    const snapshot = JSON.stringify(cfg)
    registerLoadPathIfMissing(cfg, realDir)
    expect(JSON.stringify(cfg)).toBe(snapshot)
  })

  it('treats stale (non-existent) entries as non-matching and pushes anyway', () => {
    const cfg = { plugins: { load: { paths: ['/non/existent/path'] } } }
    const out = registerLoadPathIfMissing(cfg, realDir)
    expect(out.cfg.plugins.load.paths).toEqual(['/non/existent/path', realpathSync(realDir)])
    expect(out.changed).toBe(true)
  })

  it('is idempotent across re-runs', () => {
    const first = registerLoadPathIfMissing({}, realDir)
    const second = registerLoadPathIfMissing(first.cfg, realDir)
    expect(second.cfg).toEqual(first.cfg)
    expect(second.changed).toBe(false)
  })
})
