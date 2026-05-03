#!/usr/bin/env node
// Programmatic openclaw-scanner runner. Used by:
//   1. tests/unit/scanner-check.test.ts (imports scanPublishedFiles)
//   2. package.json scripts.prepack (CLI entry — exits non-zero on critical)
//
// Resolves the openclaw scanner from node_modules. The scanner lives at a
// hashed-filename internal chunk (./dist/skill-scanner-{8 chars}.js); the
// hash rotates on every openclaw release, so we glob-find it instead of
// hard-coding the filename. If a future openclaw version adds a public
// re-export through openclaw/plugin-sdk/*, this resolver picks that up via
// the named-export try first.
//
// No new dependencies — uses node:fs, node:path, node:url. AGENTS.md §10.

import { readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

// Files that npm publish would include. Mirror package.json `files: []`
// minus the docs (non-code). The scanner only reads .ts/.mjs/.cjs/.mts/.cts
// /.jsx/.tsx files anyway (its SCANNABLE_EXTENSIONS set), so README/LICENSE/
// openclaw.plugin.json/llms*.txt are no-ops; we filter explicitly for
// readability + to keep the file count bounded.
const PUBLISHED_DIRS = ['bin', 'src']
const PUBLISHED_FILES = ['index.ts']
const SCANNABLE_EXT = new Set(['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts', '.jsx', '.tsx'])

function hasScannableExt(filename) {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return false
  return SCANNABLE_EXT.has(filename.slice(dot))
}

// Walk a directory, return all scannable files (absolute paths). Skips
// dotfiles + node_modules to mirror what npm-pack would include from a
// directory listed in package.json `files`.
function walkScannable(dirAbs) {
  const out = []
  const stack = [dirAbs]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const abs = join(cur, e.name)
      if (e.isDirectory()) stack.push(abs)
      else if (e.isFile() && hasScannableExt(e.name)) out.push(abs)
    }
  }
  return out
}

// Returns whichever scanner API openclaw exposes. The current openclaw build
// (verified: `node_modules/openclaw/dist/skill-scanner-{8 chars}.js`) only
// exposes `scanDirectoryWithSummary` as the minified `t` export. Future
// openclaw versions may add a public `scanSource`/`scanDirectoryWithSummary`
// named export — if so, the resolver returns that instead. Both shapes flow
// through the same scanPublishedFiles() call site.
export async function resolveScannerModule() {
  // Strategy 1: named export from any plugin-sdk subpath. Try security-runtime
  // first (most likely future home). Iterate over the documented subpaths
  // we know about; ignore failures (subpath may not exist).
  const namedSubpaths = [
    'openclaw/plugin-sdk/security-runtime',
    'openclaw/plugin-sdk',
  ]
  for (const subpath of namedSubpaths) {
    try {
      const mod = await import(subpath)
      if (typeof mod.scanDirectoryWithSummary === 'function') {
        return { scanDirectoryWithSummary: mod.scanDirectoryWithSummary, source: `named:${subpath}` }
      }
    } catch { /* subpath absent in this openclaw version — fall through */ }
  }

  // Strategy 2: glob the hashed scanner file.
  const distDir = resolve(REPO_ROOT, 'node_modules', 'openclaw', 'dist')
  let hashedFile
  try {
    const entries = readdirSync(distDir)
    hashedFile = entries.find((f) => /^skill-scanner-[A-Za-z0-9_-]{8}\.js$/.test(f))
  } catch (err) {
    throw new Error(
      `scan-tarball: could not read ${distDir} (${err.message}). ` +
      `Is openclaw installed? Run \`npm ci\`.`,
    )
  }
  if (!hashedFile) {
    throw new Error(
      `scan-tarball: no skill-scanner-*.js found in ${distDir}. ` +
      `openclaw may have moved the scanner to a different path. Inspect ` +
      `node_modules/openclaw/dist/ and openclaw/plugin-sdk/* exports, then ` +
      `update scripts/scan-tarball.mjs.`,
    )
  }
  const hashedPath = join(distDir, hashedFile)
  const hashedUrl = pathToFileURL(hashedPath).href
  const mod = await import(hashedUrl)

  // Future openclaw versions may add a named scanDirectoryWithSummary export
  // alongside the minified `t`. Try it first; fall back to `t` for current
  // builds where only the minified alias exists.
  if (typeof mod.scanDirectoryWithSummary === 'function') {
    return { scanDirectoryWithSummary: mod.scanDirectoryWithSummary, source: `hashed-named:${hashedFile}` }
  }
  if (typeof mod.t === 'function') {
    return { scanDirectoryWithSummary: mod.t, source: `hashed-t:${hashedFile}` }
  }

  throw new Error(
    `scan-tarball: openclaw scanner module shape unrecognized at ${hashedPath}. ` +
    `Module exports: ${Object.keys(mod).join(', ')}. ` +
    `Update scripts/scan-tarball.mjs to match the new shape.`,
  )
}

// Scan the file set that `npm pack` would publish. Returns:
//   { scannedFiles, critical, warn, info, findings: SkillScanFinding[] }
//
// The scanner's scanDirectoryWithSummary walks the directory by default and
// adds `includeFiles` as forced files. To scan ONLY the published file set
// (not the whole repo — which would also pick up scripts/, tests/, etc.), we
// set `maxFiles` to the count of forced files. Per the scanner source, when
// forcedFiles.length >= maxFiles the walker short-circuits and returns just
// the forced set.
export async function scanPublishedFiles(rootDir = REPO_ROOT) {
  const resolved = await resolveScannerModule()

  // Build the includeFiles list (relative paths within rootDir).
  const filesAbs = []
  for (const dir of PUBLISHED_DIRS) {
    const dirAbs = resolve(rootDir, dir)
    try {
      const st = statSync(dirAbs)
      if (st.isDirectory()) filesAbs.push(...walkScannable(dirAbs))
    } catch { /* dir missing — skip */ }
  }
  for (const f of PUBLISHED_FILES) {
    const abs = resolve(rootDir, f)
    try {
      const st = statSync(abs)
      if (st.isFile() && hasScannableExt(f)) filesAbs.push(abs)
    } catch { /* file missing — skip */ }
  }

  const includeFiles = filesAbs.map((abs) => relative(rootDir, abs))
  // maxFiles must be >= 1 (Math.max(1, opts.maxFiles) in normalizeScanOptions
  // upstream). When the published code set is empty, fall through with 1 —
  // the scanner will return zero findings against an empty forced set.
  const maxFiles = Math.max(1, includeFiles.length)
  const summary = await resolved.scanDirectoryWithSummary(rootDir, {
    includeFiles,
    maxFiles,
  })
  return summary
}

// CLI entry — run scan, print summary, exit non-zero on critical.
const isCliEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isCliEntry) {
  try {
    const summary = await scanPublishedFiles()
    if (summary.critical > 0) {
      // Print rule + path + line only — not findings[].evidence. The evidence
      // string is the matched source line, which can contain real secrets if a
      // future regression introduces one. The operator can grep the file at
      // the reported line to inspect the trigger themselves.
      process.stderr.write(`\n[scan-tarball] FAIL — ${summary.critical} critical finding(s) in published files:\n`)
      for (const f of summary.findings) {
        if (f.severity !== 'critical') continue
        process.stderr.write(`  ${f.severity.toUpperCase()} ${f.ruleId} at ${f.file}:${f.line}\n`)
        process.stderr.write(`    ${f.message}\n`)
      }
      process.stderr.write(`\nFix the source file(s) above; do NOT bypass this check.\n`)
      process.exit(1)
    }
    process.stdout.write(
      `[scan-tarball] OK — ${summary.scannedFiles} files scanned, ` +
      `${summary.critical} critical / ${summary.warn} warn / ${summary.info} info findings.\n`,
    )
    if (summary.warn > 0) {
      for (const f of summary.findings) {
        if (f.severity !== 'warn') continue
        process.stderr.write(`[scan-tarball] WARN ${f.ruleId} at ${f.file}:${f.line}: ${f.message}\n`)
      }
    }
    process.exit(0)
  } catch (err) {
    process.stderr.write(`[scan-tarball] error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(2)
  }
}
