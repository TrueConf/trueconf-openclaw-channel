#!/usr/bin/env node
// Runs ClawHub's own scanners against the package before a release, so a
// warning costs a rerun instead of a published version.
//
//   npm run scan:clawhub                 build, pack and scan the working tree
//   npm run scan:clawhub -- some.tgz     scan an existing tarball
//
// The static scan is ClawHub's code at CLAWHUB_COMMIT and gives the same
// findings as the site. The LLM review uses ClawHub's prompt but runs only
// when CLAWSCAN_API_KEY is set; its verdict varies between runs, so a clean
// result lowers the odds of a "suspicious" badge rather than ruling it out.
// The site also runs VirusTotal and other scanners that need ClawHub's own
// credentials; those are not covered here.
//
// Environment:
//   CLAWSCAN_API_KEY   key for an OpenAI Responses API compatible endpoint
//   CLAWSCAN_BASE_URL  default https://openrouter.ai/api/v1
//   CLAWSCAN_MODEL     default openai/gpt-6.1-sol (ClawHub's review model)
//
// Exits 1 on a static finding outside ACCEPTED_FINDINGS or an LLM verdict
// other than benign.
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

// Without a key the review is skipped: the stub answer lets ClawHub's script
// finish, and its verdict is not printed.
const SKIPPED_REVIEW = {
  output: [{
    type: 'message',
    content: [{ type: 'output_text', text: '{"verdict":"benign","confidence":"low","summary":""}' }],
  }],
}

async function scan(tarball) {
  const apiKey = process.env.CLAWSCAN_API_KEY?.trim()
  const baseUrl = (process.env.CLAWSCAN_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
  const model = process.env.CLAWSCAN_MODEL ?? 'openai/gpt-6.1-sol'

  const dryRun = pathToFileURL(join(process.env.CLAWHUB_SCAN_DIR, 'scripts', 'local-clawscan-dry-run.ts'))
  const { runLocalClawScanDryRun } = await import(dryRun.href)

  const fetchImpl = async (url, init) => {
    if (url !== OPENAI_RESPONSES_URL) return fetch(url, init)
    if (!apiKey) return Response.json(SKIPPED_REVIEW)
    // service_tier is an OpenAI-only field that other endpoints reject.
    const { service_tier: _, ...body } = JSON.parse(init.body)
    return fetch(`${baseUrl}/responses`, { ...init, body: JSON.stringify({ ...body, model }) })
  }

  const result = await runLocalClawScanDryRun({
    path: tarball,
    kind: 'plugin',
    env: { OPENAI_API_KEY: apiKey ?? 'unused', OPENAI_EVAL_MODEL: model },
    fetchImpl,
  })

  console.log(`\n${result.name}@${result.version}, ${result.files.length} files`)
  const { staticScan, llmAnalysis } = result
  const staticClean = staticScan.findings.every((f) => ACCEPTED_FINDINGS.has(f.code))
  const accepted = staticClean && staticScan.status !== 'clean' ? ' (accepted findings only)' : ''
  console.log(`\nStatic scan: ${staticScan.status}${accepted}`)
  for (const f of staticScan.findings) {
    console.log(`  ${f.severity} ${f.code} ${f.file}:${f.line} - ${f.message}`)
    console.log(`    ${f.evidence}`)
  }

  if (!apiKey) {
    console.log('\nLLM review: skipped (set CLAWSCAN_API_KEY to run it)')
  } else {
    console.log(`\nLLM review (${model}): ${llmAnalysis.verdict}, confidence ${llmAnalysis.confidence}`)
    console.log(llmAnalysis.summary)
    for (const d of llmAnalysis.dimensions) {
      if (d.rating !== 'ok') console.log(`  [${d.rating}] ${d.label}: ${d.detail}`)
    }
    if (llmAnalysis.guidance) console.log(`\nGuidance: ${llmAnalysis.guidance}`)
  }

  const clean = staticClean && (!apiKey || llmAnalysis.status === 'clean')
  process.exit(clean ? 0 : 1)
}

if (typeof Bun === 'undefined') await prepare()
else await scan(process.argv[2])
