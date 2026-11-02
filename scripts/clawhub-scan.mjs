#!/usr/bin/env node
// Runs ClawHub's static scan against the package before a release, so a
// warning costs a rerun instead of a published version.
//
//   npm run scan:clawhub                 build, pack and scan the working tree
//   npm run scan:clawhub -- some.tgz     scan an existing tarball
//
// The scan is ClawHub's own code at CLAWHUB_COMMIT and gives the same
// findings as the site. Exits 1 on a finding outside ACCEPTED_FINDINGS.
// The verdict of ClawHub's AI review comes from ClawScan, which the
// "ClawHub scan" workflow (clawhub-scan.yml) runs.
//
// ClawHub's script needs Bun, so this file runs twice: under Node it prepares
// the ClawHub checkout and the tarball, then reruns itself under Bun to scan.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLAWHUB_REPO = 'https://github.com/openclaw/clawhub.git'
const CLAWHUB_COMMIT = '56e7ee8aaef8a0e180f906fd7bf194dd1b03bc45'
const BUN = 'bun@1.3.14'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const CLAWHUB_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'clawhub', CLAWHUB_COMMIT)
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

// tlsVerify=false is a supported mode for TrueConf Server with a self-signed
// certificate, so ClawHub always flags it. These findings are printed but do
// not fail the scan.
const ACCEPTED_FINDINGS = new Set(['suspicious.insecure_tls_verification'])

const isWindows = process.platform === 'win32'

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', shell: isWindows, ...opts })
}

function prepareClawHub() {
  const ready = join(CLAWHUB_DIR, '.trueconf-ready')
  if (existsSync(ready)) return
  console.log(`Fetching ClawHub ${CLAWHUB_COMMIT.slice(0, 8)} into ${CLAWHUB_DIR}`)
  mkdirSync(CLAWHUB_DIR, { recursive: true })
  run('git', ['init', '-q'], { cwd: CLAWHUB_DIR })
  run('git', ['fetch', '-q', '--depth', '1', CLAWHUB_REPO, CLAWHUB_COMMIT], { cwd: CLAWHUB_DIR })
  run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: CLAWHUB_DIR })
  run('npx', ['--yes', BUN, 'install', '--frozen-lockfile', '--ignore-scripts'], { cwd: CLAWHUB_DIR })
  writeFileSync(ready, '')
}

function packWorkingTree() {
  // A stale dist/ keeps modules whose sources are gone; CI builds from scratch.
  rmSync(join(REPO_ROOT, 'dist'), { recursive: true, force: true })
  run('npm', ['run', 'build'], { cwd: REPO_ROOT })
  const dest = mkdtempSync(join(tmpdir(), 'clawhub-scan-'))
  const out = execFileSync('npm', ['pack', '--pack-destination', dest], {
    cwd: REPO_ROOT,
    shell: isWindows,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return join(dest, out.trim().split('\n').at(-1).trim())
}

async function prepare() {
  prepareClawHub()
  const tarball = process.argv[2] ? resolve(process.argv[2]) : packWorkingTree()
  const result = spawnSync('npx', ['--yes', BUN, fileURLToPath(import.meta.url), tarball], {
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, CLAWHUB_SCAN_DIR: CLAWHUB_DIR },
  })
  process.exit(result.status ?? 1)
}

// ClawHub's script always asks an LLM for a review as well. Its prompt sees only
// the first 50K characters of the package, so the stub answer skips it.
const SKIPPED_REVIEW = {
  output: [{
    type: 'message',
    content: [{ type: 'output_text', text: '{"verdict":"benign","confidence":"low","summary":""}' }],
  }],
}

async function scan(tarball) {
  const dryRun = pathToFileURL(join(process.env.CLAWHUB_SCAN_DIR, 'scripts', 'local-clawscan-dry-run.ts'))
  const { runLocalClawScanDryRun } = await import(dryRun.href)

  const { name, version, files, staticScan } = await runLocalClawScanDryRun({
    path: tarball,
    kind: 'plugin',
    env: { OPENAI_API_KEY: 'unused' },
    fetchImpl: async (url, init) => (url === OPENAI_RESPONSES_URL ? Response.json(SKIPPED_REVIEW) : fetch(url, init)),
  })

  console.log(`
${name}@${version}, ${files.length} files`)
  const clean = staticScan.findings.every((f) => ACCEPTED_FINDINGS.has(f.code))
  const accepted = clean && staticScan.status !== 'clean' ? ' (accepted findings only)' : ''
  console.log(`
Static scan: ${staticScan.status}${accepted}`)
  for (const f of staticScan.findings) {
    console.log(`  ${f.severity} ${f.code} ${f.file}:${f.line} - ${f.message}`)
    console.log(`    ${f.evidence}`)
  }
  process.exit(clean ? 0 : 1)
}

if (typeof Bun === 'undefined') await prepare()
else await scan(process.argv[2])
