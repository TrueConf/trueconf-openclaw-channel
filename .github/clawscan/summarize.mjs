#!/usr/bin/env node
// Prints a Markdown summary of a ClawScan artifact (for $GITHUB_STEP_SUMMARY)
// and exits 1 unless the run completed and the judge returned "benign".

import { readFileSync } from 'node:fs'

const artifact = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const judge = artifact.judge ?? {}
const result = judge.result && typeof judge.result === 'object' ? judge.result : undefined

const out = ['## ClawScan (clawhub profile)', '']
out.push(`Run: ${artifact.status ?? 'unknown'}${artifact.complete ? '' : ' (incomplete)'}`)
if (artifact.error) out.push(`Error: ${artifact.error}`)
out.push('', '| Scanner | Status | Error |', '| --- | --- | --- |')
for (const [id, scanner] of Object.entries(artifact.scanners ?? {})) {
  out.push(`| ${id} | ${scanner.status} | ${scanner.error ?? ''} |`)
}
out.push('', `Judge: ${judge.status ?? 'not run'}${judge.error ? ` - ${judge.error}` : ''}`)

if (result) {
  out.push('', `### Verdict: ${result.verdict} (confidence ${result.confidence})`, '', result.summary ?? '')
  for (const [name, dim] of Object.entries(result.dimensions ?? {})) {
    if (dim.status !== 'ok') out.push('', `- **${name}** (${dim.status}): ${dim.detail}`)
  }
  for (const finding of result.scan_findings_in_context ?? []) {
    out.push('', `- ${typeof finding === 'string' ? finding : JSON.stringify(finding)}`)
  }
  if (result.user_guidance) out.push('', `**Guidance:** ${result.user_guidance}`)
}

console.log(out.join('\n'))
process.exit(artifact.complete && result?.verdict === 'benign' ? 0 : 1)
