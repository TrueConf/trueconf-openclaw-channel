#!/usr/bin/env node
// Programmatic openclaw-scanner runner — dual purpose:
//   - imported library: scanPublishedFiles() returns the summary
//   - CLI (npm pack prepack hook): exits 1 on critical, 2 on error

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

const SCANNABLE_EXT = new Set(['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts', '.jsx', '.tsx'])

function hasScannableExt(filename) {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return false
  return SCANNABLE_EXT.has(filename.slice(dot))
}

// Derived from package.json:files at module load so the scan scope cannot
// drift from what npm publishes. Non-scannable entries (LICENSE, README,
// llms*.txt, openclaw.plugin.json) are filtered out.
const pkgRaw = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')
const PUBLISHED_DIRS = []
const PUBLISHED_FILES = []
for (const entry of (JSON.parse(pkgRaw).files ?? [])) {
  if (typeof entry !== 'string') continue
  if (entry.endsWith('/')) PUBLISHED_DIRS.push(entry.slice(0, -1))
  else if (hasScannableExt(entry)) PUBLISHED_FILES.push(entry)
}

// ENOENT on a stale entry is tolerated; permission/IO errors must surface —
// a published file the scanner cannot read is a security gap, not a skip.
function walkScannable(dirAbs) {
  const out = []
  const stack = [dirAbs]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw new Error(`scan-tarball: cannot read ${cur} (${err.code ?? err.name}: ${err.message})`)
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

// The openclaw scanner ships as a minified chunk at
// node_modules/openclaw/dist/skill-scanner-{8 chars}.js exposing only `t`.
// Hash rotates per release, so glob-find it.
export async function resolveScannerModule() {
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
      `openclaw may have moved the scanner — update scripts/scan-tarball.mjs.`,
    )
  }
  const hashedPath = join(distDir, hashedFile)
  const mod = await import(pathToFileURL(hashedPath).href)
  if (typeof mod.t !== 'function') {
    throw new Error(
      `scan-tarball: ${hashedPath} exports ${Object.keys(mod).join(', ') || '(nothing)'}; ` +
      `expected minified \`t\` function. Update scripts/scan-tarball.mjs.`,
    )
  }
  return { scanDirectoryWithSummary: mod.t, source: `hashed-t:${hashedFile}` }
}

// Setting maxFiles to filesAbs.length short-circuits the upstream walker
// (forcedFiles.length >= maxFiles) so it returns only the forced set
// instead of walking the whole repo.
export async function scanPublishedFiles(rootDir = REPO_ROOT) {
  const resolved = await resolveScannerModule()

  const filesAbs = []
  for (const dir of PUBLISHED_DIRS) {
    const dirAbs = resolve(rootDir, dir)
    try {
      const st = statSync(dirAbs)
      if (st.isDirectory()) filesAbs.push(...walkScannable(dirAbs))
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`scan-tarball: cannot stat ${dirAbs} (${err.code ?? err.name}: ${err.message})`)
      }
    }
  }
  for (const f of PUBLISHED_FILES) {
    const abs = resolve(rootDir, f)
    try {
      const st = statSync(abs)
      if (st.isFile() && hasScannableExt(f)) filesAbs.push(abs)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`scan-tarball: cannot stat ${abs} (${err.code ?? err.name}: ${err.message})`)
      }
    }
  }

  // Refuse to pass on empty: upstream maxFiles=Math.max(1,…) would walk
  // REPO_ROOT and the gate would pass vacuously.
  if (filesAbs.length === 0) {
    throw new Error(
      `scan-tarball: no scannable files found under published file set ` +
      `(dirs=[${PUBLISHED_DIRS.join(', ')}] files=[${PUBLISHED_FILES.join(', ')}]). ` +
      `Either package.json "files" is stale or the source tree is missing.`,
    )
  }

  const includeFiles = filesAbs.map((abs) => relative(rootDir, abs))
  const summary = await resolved.scanDirectoryWithSummary(rootDir, {
    includeFiles,
    maxFiles: includeFiles.length,
  })
  return summary
}

// CLI entry — realpathSync resolves any symlink shim npm/npx may interpose.
const isCliEntry = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()
if (isCliEntry) {
  try {
    const summary = await scanPublishedFiles()
    if (summary.critical > 0) {
      // Print rule + path + line only — never findings[].evidence (matched
      // source line; could leak real secrets if a regression introduces one).
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
