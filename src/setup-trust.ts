import { readFileSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'
import { homedir } from 'node:os'
import type { WizardPrompter } from 'openclaw/plugin-sdk/setup'
import type { CertSummary, ValidatedCaBytes, ValidateCaAgainstServerParams, ValidateCaAgainstServerResult } from './probe.d.mts'
import type { Locale } from './i18n'
import { t } from './i18n'

export function resolveAbsPath(raw: string): string {
  const expanded = raw.startsWith('~/') || raw === '~'
    ? raw.replace(/^~/, homedir())
    : raw
  return pathResolve(expanded)
}

export function shortFp(fp: string | null | undefined): string {
  if (!fp) return '?'
  return fp.length > 29 ? `${fp.slice(0, 29)}…` : fp
}

// Probe primitives injected so the module stays decoupled from probe.mjs's
// static binding (avoids a setup-trust ↔ channel-setup import cycle and lets
// the CLI pass its own probeModule). Onboard passes the probe.mjs namespace.
export interface ProbeModule {
  probeTls: (p: { host: string; port?: number }) => Promise<{ reachable: boolean; useTls: boolean; port: number; caUntrusted?: boolean; cert?: CertSummary; error?: string }>
  parseCertFromPem: (b: Buffer | Uint8Array) => CertSummary | null
  validateCaAgainstServer: (p: ValidateCaAgainstServerParams) => Promise<ValidateCaAgainstServerResult>
}

export async function promptInsecureConfirm(args: { prompter: WizardPrompter; locale: Locale }): Promise<boolean> {
  const { prompter, locale } = args
  await prompter.note(t('tls.insecure.warning', locale), t('tls.untrusted.title', locale))
  return prompter.confirm({ message: t('tls.insecure.confirm', locale), initialValue: false })
}

const MAX_CA_FILE_ATTEMPTS = 3

export async function readCaFileInteractive(args: {
  prompter: WizardPrompter
  probe: ProbeModule
  host: string
  port: number
  locale: Locale
}): Promise<{ nextCaPath: string; nextCaBytes: ValidatedCaBytes }> {
  const { prompter, probe, host, port, locale } = args
  const reasons: string[] = []
  // Render the CA-path hint banner once before entering the retry loop. The
  // hint explains where TrueConf admins typically find the cert (*.crt under
  // HTTPS panel) and that it can be renamed to *.pem if already in PEM. Lives
  // here so all callers (fresh-untrusted, missing-file, mismatch) see the
  // same guidance the moment they pick "use a file".
  const hint = [
    t('tls.cafile.hint.intro', locale),
    t('tls.cafile.hint.format', locale),
    t('tls.cafile.hint.location', locale),
  ].join('\n\n')
  await prompter.note(hint, t('cafile.title', locale))
  for (let attempt = 0; attempt < MAX_CA_FILE_ATTEMPTS; attempt++) {
    const rawPath = String(await prompter.text({
      message: t('cafile.prompt', locale),
    }))
    // Empty input = the user cancelled the prompt (Ctrl+C in real prompters,
    // drained script queue in test prompters). Bail out fast with an
    // explicit cause instead of burning the remaining attempts on cwd reads.
    if (!rawPath.trim()) {
      throw new Error('CA file input cancelled — empty path received from prompter')
    }
    const abs = resolveAbsPath(rawPath)
    let bytes: Buffer
    try {
      bytes = readFileSync(abs)
    } catch (err) {
      const reason = t('tls.cafile.unreadable', locale, { path: abs, reason: (err as Error).message })
      reasons.push(reason)
      await prompter.note(reason, t('cafile.title', locale))
      continue
    }
    const cert = probe.parseCertFromPem(bytes)
    if (!cert) {
      const reason = `${abs}: не PEM`
      reasons.push(reason)
      await prompter.note(
        t('cafile.notPem', locale),
        t('cafile.title', locale),
      )
      continue
    }
    const v = await probe.validateCaAgainstServer({ caBytes: bytes, host, port })
    if (!v.ok) {
      if (v.kind === 'unreachable') {
        reasons.push(`${abs}: server unreachable (${v.error})`)
        await prompter.note(
          t('cafile.unreachable', locale, { host, port, error: v.error }),
          t('cafile.title', locale),
        )
      } else {
        reasons.push(`${abs}: chain mismatch (${v.error})`)
        await prompter.note(
          t('cafile.chainMismatch', locale, {
            fileIssuer: cert.issuerCN ?? cert.subject ?? '?',
            fileFp: shortFp(cert.fingerprint),
            serverIssuer: v.serverCert?.issuerCN ?? v.serverCert?.subject ?? '?',
            serverFp: shortFp(v.serverCert?.fingerprint),
            error: v.error,
          }),
          t('cafile.title', locale),
        )
      }
      continue
    }
    return { nextCaPath: abs, nextCaBytes: v.caBytes }
  }
  throw new Error(
    `CA file input failed ${MAX_CA_FILE_ATTEMPTS} times. Attempts: ${reasons.join('; ')}`,
  )
}

// Discriminated union — caPath and caBytes are CO-REQUIRED (TOCTOU); the three
// terminal outcomes are explicit so callers map clearFields correctly. Abort throws.
export type TrustDecision =
  | { kind: 'pinned'; caPath: string; caBytes: ValidatedCaBytes }
  | { kind: 'insecure' }
  | { kind: 'system' }

export interface ReviewExistingTrustArgs {
  prompter: WizardPrompter
  probe: ProbeModule
  host: string
  port: number
  current: { caPath?: string; tlsVerify?: boolean }
  alreadyValidated?: { caBytes: ValidatedCaBytes }
  locale: Locale
}

// Interactive keep/change trust gate shown on a wizard re-run. Onboard passes
// pre-validated bytes via `alreadyValidated` (skip re-validation); the CLI omits
// it so this re-reads + re-validates internally (Task 6 branch).
export async function reviewExistingTrust(args: ReviewExistingTrustArgs): Promise<TrustDecision> {
  const { prompter, current, alreadyValidated, locale } = args
  if (current.caPath && alreadyValidated) {
    const resolved = resolveAbsPath(current.caPath)
    await prompter.note(t('trust.review.currentCaFile', locale, { path: resolved }), t('trust.review.keepTitle', locale))
    const keep = await prompter.confirm({ message: t('trust.review.keep', locale), initialValue: true })
    if (keep) return { kind: 'pinned', caPath: resolved, caBytes: alreadyValidated.caBytes }
    return changeMenu(args)
  }
  if (current.tlsVerify === false && !current.caPath) {
    await prompter.note(t('trust.review.currentInsecure', locale), t('trust.review.keepTitle', locale))
    const keep = await prompter.confirm({ message: t('trust.review.keep', locale), initialValue: true })
    if (keep) return { kind: 'insecure' }
    return changeMenu(args)
  }
  throw new Error('reviewExistingTrust: branch not implemented (Task 5/6)')
}

async function changeMenu(args: ReviewExistingTrustArgs): Promise<TrustDecision> {
  const { prompter, probe, host, port, locale } = args
  const choice = await prompter.select<string>({
    message: t('trust.review.changePrompt', locale),
    options: [
      { value: 'use-file', label: t('trust.review.optionCaFile', locale) },
      { value: 'insecure', label: t('tls.untrusted.choice.insecure', locale) },
      { value: 're-probe', label: t('trust.review.optionReprobe', locale) },
      { value: 'abort',    label: t('select.option.abortSetup', locale) },
    ],
  })
  if (choice === 'use-file') {
    const r = await readCaFileInteractive({ prompter, probe, host, port, locale })
    return { kind: 'pinned', caPath: r.nextCaPath, caBytes: r.nextCaBytes }
  }
  if (choice === 'insecure') {
    const ok = await promptInsecureConfirm({ prompter, locale })
    if (!ok) throw new Error(`Trust change: user declined to disable verification on ${host}`)
    return { kind: 'insecure' }
  }
  if (choice === 're-probe') return reprobe(args)
  // Empty/unrecognized select (drained queue or explicit cancel): abort with an
  // explicit error. Do NOT fall through to use-file (spec §3.C footgun).
  throw new Error(`Trust change cancelled on ${host} (choice="${choice}")`)
}

async function reprobe(args: ReviewExistingTrustArgs): Promise<TrustDecision> {
  const { prompter, probe, host, port, locale } = args
  const p = await probe.probeTls({ host, port })
  if (p.reachable && !p.caUntrusted) return { kind: 'system' }
  // still untrusted → fresh-untrusted sub-flow, NO auto-download / TOFU
  const choice = await prompter.select<string>({
    message: t('select.whatToDo', locale),
    options: [
      { value: 'use-file', label: t('tls.untrusted.choice.use-file', locale) },
      { value: 'insecure', label: t('tls.untrusted.choice.insecure', locale) },
      { value: 'abort',    label: t('select.option.abortSetup', locale) },
    ],
  })
  if (choice === 'use-file') {
    const r = await readCaFileInteractive({ prompter, probe, host, port, locale })
    return { kind: 'pinned', caPath: r.nextCaPath, caBytes: r.nextCaBytes }
  }
  if (choice === 'insecure') {
    const ok = await promptInsecureConfirm({ prompter, locale })
    if (!ok) throw new Error(`Trust change: user declined insecure on ${host}`)
    return { kind: 'insecure' }
  }
  throw new Error(`Trust change cancelled on ${host} after re-probe`)
}
