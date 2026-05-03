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

// Derive the published file set from package.json `files: []` so the scan
// scope cannot drift from what npm actually publishes. Directories (entries
// ending in `/`) are walked for scannable extensions; non-directory entries
// with a scannable extension are forced files; everything else (LICENSE,
// README, openclaw.plugin.json, llms*.txt) is a non-code no-op for the
// scanner and skipped here.
const { PUBLISHED_DIRS, PUBLISHED_FILES } = (() => {
  const pkgPath = resolve(REPO_ROOT, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (err) {
    throw new Error(`scan-tarball: could not read ${pkgPath} (${err.message}).`)
  }
  const dirs = []
  const files = []
  for (const entry of pkg.files ?? []) {
    if (typeof entry !== 'string') continue
    if (entry.endsWith('/')) {
      dirs.push(entry.slice(0, -1))
    } else if (hasScannableExt(entry)) {
      files.push(entry)
    }
  }
  return { PUBLISHED_DIRS: dirs, PUBLISHED_FILES: files }
})()

// Walk a directory, return all scannable files (absolute paths). Skips
// dotfiles + node_modules to mirror what npm-pack would include from a
// directory listed in package.json `files`. ENOENT on a stale entry is
// tolerated; permission/IO errors must surface — a published file the
// scanner cannot read is a security gap, not a skip-able anomaly.
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

// The openclaw scanner ships as a minified internal chunk
// `node_modules/openclaw/dist/skill-scanner-{8 chars}.js` exposing only
// `t` (no named API). Hash rotates per release, so glob-find it.
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

  // Build the includeFiles list (relative paths within rootDir). ENOENT
  // is tolerated (a stale entry in package.json files: list); other errors
  // surface so a permission-denied file in the published tree fails loud
  // instead of silently exiting the scan scope.
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

  // Empty file set means package.json files: list is stale or the source
  // tree has drifted. Refuse to pass — without this guard the upstream
  // scanner walks REPO_ROOT with maxFiles=1 and the gate passes vacuously.
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

// CLI entry — run scan, print summary, exit non-zero on critical.
// realpathSync resolves any symlink shim that npm/npx may interpose, mirroring
// the bin/trueconf-setup.mjs guard so behavior is uniform across invocation
// paths (direct node, prepack, future npx exposure).
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
