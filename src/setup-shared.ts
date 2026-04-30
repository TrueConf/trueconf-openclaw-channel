// Shared setup helpers consumed by:
//   - bin/trueconf-setup.mjs (standalone CLI)
//   - src/setup-entry.ts (setup-only plugin entry — onboard inline-wizard via SDK setup adapter)
//   - src/channel.ts (full plugin entry — onboard inline-wizard via SDK setup adapter)
//
// Single source of truth for the SDK setup adapter (consumed by openclaw's
// onboard runtime) AND the programmatic wizard-finalize orchestrator (consumed
// by the bin's interactive runSetup body). Keeps CLI/SDK in parity — no
// behavior drift across entry points.

import { homedir } from 'node:os'
import { resolve as pathResolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createPatchedAccountSetupAdapter } from 'openclaw/plugin-sdk/setup'
import type {
  ChannelSetupAdapter,
  ChannelSetupWizard,
  OpenClawConfig,
  WizardPrompter,
} from 'openclaw/plugin-sdk/setup'
import type {
  CertSummary,
  ProbeTlsParams,
  ProbeTlsResult,
  ValidateCaAgainstServerParams,
  ValidateCaAgainstServerResult,
  ValidateOAuthCredentialsParams,
  ValidateOAuthCredentialsResult,
  ValidatedCaBytes,
} from './probe.d.mts'
import type { Locale } from './i18n'

// Bin and the inline-wizard runtime both extend WizardPrompter with a
// `password` method (the SDK's WizardPrompter does NOT include it). The
// extended shape is kept local here so setup-shared.ts compiles regardless
// of which call-site instantiates the prompter.
type SetupPrompter = WizardPrompter & {
  password: (params: { message: string; validate?: (value: string) => string | undefined }) => Promise<string>
}

type TFn = (key: string, locale: Locale, vars?: Record<string, string | number>) => string

// Probe surface contract — matches src/probe.mjs (typed via src/probe.d.mts).
// Importing the source-of-truth types instead of hand-rolling them keeps the
// probe stub seams in tests/unit/setup-adapter.test.ts honest: a future probe
// signature change surfaces as a TypeScript error here, not a runtime mismatch.
interface ProbeModule {
  probeTls: (params: ProbeTlsParams) => Promise<ProbeTlsResult>
  parseCertFromPem: (bytes: Buffer | Uint8Array) => CertSummary | null
  validateCaAgainstServer: (params: ValidateCaAgainstServerParams) => Promise<ValidateCaAgainstServerResult>
  validateOAuthCredentials: (params: ValidateOAuthCredentialsParams) => Promise<ValidateOAuthCredentialsResult>
}

// === Wizard prompt helpers ===
// Extracted from bin/trueconf-setup.mjs (lines 243-471 in the pre-extract
// state). Behavior preserved verbatim — all three integration tests for the
// bin (tests/integration/bin-trueconf-setup.test.ts) plus the CLI subprocess
// tests (tests/integration/bin-cli-subprocess-exits.test.ts) act as the
// regression net.

export async function promptInteractiveInputs(
  prompter: SetupPrompter,
  wizard: ChannelSetupWizard,
  currentCfg: OpenClawConfig,
  t: TFn,
  locale: Locale,
): Promise<OpenClawConfig> {
  let cfg = currentCfg
  for (const input of wizard.textInputs ?? []) {
    const current = input.currentValue
      ? input.currentValue({ cfg, accountId: 'default', credentialValues: {} })
      : undefined
    if (!input.required && (current === undefined || current === '')) continue

    const placeholder = input.placeholder ?? (typeof current === 'string' ? current : '')
    const raw = await prompter.text({
      message: input.message,
      placeholder,
      initialValue: typeof current === 'string' ? current : undefined,
    })
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '' && !input.applyEmptyValue && current !== undefined) continue
    if (value === '' && input.required) {
      throw new Error(t('bin.fieldRequired', locale, { message: input.message }))
    }
    if (input.validate) {
      const err = input.validate({ value, cfg, accountId: 'default', credentialValues: {} })
      if (err) throw new Error(`${input.message}: ${err}`)
    }
    const normalized = input.normalizeValue
      ? input.normalizeValue({ value, cfg, accountId: 'default', credentialValues: {} })
      : value
    if (!input.applySet) throw new Error(`textInput ${String(input.inputKey)}.applySet missing — wizard descriptor invariant broken`)
    cfg = await input.applySet({ cfg, value: normalized, accountId: 'default' })
  }
  return cfg
}

export async function promptPassword(
  prompter: SetupPrompter,
  wizard: ChannelSetupWizard,
  cfg: OpenClawConfig,
  t: TFn,
  locale: Locale,
): Promise<{ cfg: OpenClawConfig; credentialValues: Record<string, string> }> {
  const credential = wizard.credentials[0]
  const state = credential.inspect({ cfg, accountId: 'default' })
  const allowEnv = credential.allowEnv ? credential.allowEnv({ cfg, accountId: 'default' }) : false

  if (allowEnv && state.envValue) {
    const useEnv = await prompter.confirm({
      message: credential.envPrompt ?? t('bin.useEnvVar', locale, { var: credential.preferredEnvVar ?? '' }),
      initialValue: true,
    })
    if (useEnv && credential.applyUseEnv) {
      const nextCfg = await credential.applyUseEnv({ cfg, accountId: 'default' })
      return { cfg: nextCfg, credentialValues: { [credential.inputKey]: state.envValue } }
    }
  }

  if (state.hasConfiguredValue) {
    const keep = await prompter.confirm({
      message: credential.keepPrompt ?? t('bin.passwordKeep', locale),
      initialValue: true,
    })
    if (keep) return { cfg, credentialValues: {} }
  }

  const pwd = await prompter.password({ message: credential.inputPrompt ?? t('bin.passwordPrompt', locale) })
  if (typeof pwd !== 'string' || pwd === '') throw new Error(t('bin.passwordEmpty', locale))
  if (!credential.applySet) throw new Error('credential.applySet missing — wizard descriptor invariant broken')
  const nextCfg = await credential.applySet({
    cfg,
    accountId: 'default',
    credentialValues: {},
    value: pwd,
    resolvedValue: pwd,
  })
  return { cfg: nextCfg, credentialValues: { [credential.inputKey]: pwd } }
}

export async function promptProbePreview(
  prompter: SetupPrompter,
  probeModule: ProbeModule,
  serverUrl: string,
  currentUseTls: boolean | undefined,
  currentPort: number | undefined,
  currentCaPath: string | undefined,
  t: TFn,
  locale: Locale,
): Promise<{
  useTls: boolean
  port: number
  caPath: string | undefined
  caBytes: Buffer | Uint8Array | undefined
  tlsVerify: boolean | undefined
}> {
  // If user pinned useTls + port in cfg, skip probe and respect choice.
  // useTls=false renders caPath moot (mutually exclusive trust modes), so
  // clear it in that case.
  if (currentUseTls !== undefined && currentPort !== undefined) {
    const effectiveCaPath = currentUseTls === false ? undefined : currentCaPath
    // Load caBytes here so the OAuth retry loop downstream can pin trust to
    // the operator's stored CA. Throws loud on read failure — silent fallback
    // would downgrade pinned-CA trust to system trust without indication
    // (AGENTS.md "no silent fallbacks on readFileSync(caPath)" invariant).
    let caBytes: Buffer | Uint8Array | undefined
    if (effectiveCaPath) {
      try {
        caBytes = readFileSync(effectiveCaPath)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(`CA file unreadable: ${effectiveCaPath} (${reason})`)
      }
    }
    return {
      useTls: currentUseTls,
      port: currentPort,
      caPath: effectiveCaPath,
      caBytes,
      tlsVerify: undefined,
    }
  }

  await prompter.note(t('probe.detecting', locale), t('probe.title', locale))
  const probe = await probeModule.probeTls({ host: serverUrl, port: currentPort })

  let useTls: boolean | undefined
  let port: number | undefined
  let caPath: string | undefined
  let caBytes: Buffer | Uint8Array | undefined
  let tlsVerify: boolean | undefined
  let reason: string | undefined
  if (probe.reachable) {
    useTls = currentUseTls ?? probe.useTls
    port = currentPort ?? probe.port
    if (probe.caUntrusted && useTls) {
      const choice = await prompter.select({
        message: t('select.whatToDo', locale),
        options: [
          { value: 'use-file', label: t('tls.untrusted.choice.use-file', locale) },
          { value: 'insecure', label: t('tls.untrusted.choice.insecure', locale) },
          { value: 'abort',    label: t('select.option.abortSetup', locale) },
        ],
      })
      if (choice === 'abort') {
        throw new Error(`User aborted: untrusted cert on ${serverUrl}`)
      }
      if (choice === 'use-file') {
        const hint = [
          t('tls.cafile.hint.intro', locale),
          t('tls.cafile.hint.format', locale),
          t('tls.cafile.hint.location', locale),
        ].join('\n')
        await prompter.note(hint, t('cafile.title', locale))
        const raw = await prompter.text({ message: t('cafile.prompt', locale) })
        if (typeof raw !== 'string' || raw.trim() === '') {
          throw new Error(`User aborted: empty CA path`)
        }
        const expanded = raw.startsWith('~/') || raw === '~' ? raw.replace(/^~/, homedir()) : raw
        const abs = pathResolve(expanded)
        let bytes: Buffer
        try {
          bytes = readFileSync(abs)
        } catch (err) {
          throw new Error(t('tls.cafile.unreadable', locale, {
            path: abs, reason: err instanceof Error ? err.message : String(err),
          }))
        }
        const cert = probeModule.parseCertFromPem(bytes)
        if (!cert) {
          throw new Error(t('cafile.notPem', locale))
        }
        const v = await probeModule.validateCaAgainstServer({ caBytes: bytes, host: serverUrl, port })
        if (!v.ok) {
          if (v.kind === 'unreachable') {
            throw new Error(t('cafile.unreachable', locale, { host: serverUrl, port: port as number, error: v.error ?? '' }))
          }
          throw new Error(t('cafile.chainMismatch', locale, {
            fileIssuer: cert.issuerCN ?? cert.subject ?? '?',
            fileFp: cert.fingerprint ?? '?',
            serverIssuer: v.serverCert?.issuerCN ?? '?',
            serverFp: v.serverCert?.fingerprint ?? '?',
            error: v.error ?? '',
          }))
        }
        caPath = abs
        caBytes = bytes
      } else {
        await prompter.note(t('tls.insecure.warning', locale), t('tls.untrusted.title', locale))
        const confirmed = await prompter.confirm({
          message: t('tls.insecure.confirm', locale),
          initialValue: false,
        })
        if (!confirmed) throw new Error(`User aborted: untrusted cert on ${serverUrl}`)
        tlsVerify = false
      }
    }
    reason = probe.caUntrusted ? (tlsVerify === false ? 'tls-insecure' : 'tls-untrusted') : (useTls ? 'tls-valid' : 'bridge-open')
  } else {
    // Probe failure is a hint, not a gate: OAuth over a corporate proxy can
    // still succeed even when a raw TLS probe is firewalled.
    await prompter.note(
      t('probe.skipped', locale, { error: probe.error ?? 'unknown' }),
      t('probe.skippedTitle', locale),
    )
    useTls = currentUseTls ?? true
    port = currentPort ?? 443
    reason = 'fallback'
  }

  // Preview + let user override.
  const scheme = useTls ? 'wss' : 'ws'
  const isDefaultPort = (useTls && port === 443) || (!useTls && port === 80)
  const hostPart = isDefaultPort ? serverUrl : `${serverUrl}:${port}`
  const caClause = caPath ? t('probe.preview.reason.caClause', locale, { path: caPath }) : ''
  const reasonLabels: Record<string, string> = {
    'tls-valid': t('probe.preview.reason.tlsValid', locale, { port: port as number }),
    'tls-untrusted': t('probe.preview.reason.tlsUntrusted', locale, { port: port as number, caClause }),
    'tls-insecure': t('probe.preview.reason.tlsInsecure', locale, { port: port as number }),
    'bridge-open': t('probe.preview.reason.bridgeOpen', locale, { port: port as number }),
    'fallback': t('probe.preview.reason.fallback', locale, { port: port as number }),
  }
  await prompter.note(
    `${scheme}://${hostPart}/websocket/chat_bot/\n(${reasonLabels[reason ?? ''] ?? reason})`,
    t('probe.preview.title', locale),
  )

  const accept = await prompter.confirm({
    message: t('probe.preview.accept', locale),
    initialValue: true,
  })
  if (accept) return { useTls: useTls as boolean, port: port as number, caPath, caBytes, tlsVerify }

  // Manual override branch.
  const manualTls = await prompter.confirm({ message: t('probe.preview.tlsToggle', locale), initialValue: useTls as boolean })
  const manualPortDefault = manualTls ? 443 : 4309
  const manualPortRaw = await prompter.text({
    message: t('probe.preview.port', locale, { default: manualPortDefault }),
    placeholder: String(manualPortDefault),
  })
  const manualPortTrimmed = typeof manualPortRaw === 'string' ? manualPortRaw.trim() : ''
  const manualPort = manualPortTrimmed === '' ? manualPortDefault : Number.parseInt(manualPortTrimmed, 10)
  if (!Number.isFinite(manualPort) || manualPort < 1 || manualPort > 65535) {
    throw new Error(t('probe.preview.invalidPort', locale, { value: String(manualPortRaw) }))
  }
  return { useTls: manualTls, port: manualPort, caPath, caBytes, tlsVerify }
}

export function patchChannelWithFinalValues(
  cfg: OpenClawConfig,
  values: {
    serverUrl: string
    username: string
    password: string
    useTls: boolean
    port: number
    caPath?: string
    tlsVerify?: boolean
    setupLocale?: Locale
  },
): OpenClawConfig {
  // Mutually exclusive trust modes: when tlsVerify === false the saved cfg
  // must NOT carry a stale caPath — runtime would otherwise see two
  // contradictory trust signals.
  const cfgWithChannels = cfg as { channels?: { trueconf?: Record<string, unknown> } }
  const existing = cfgWithChannels.channels?.trueconf ?? {}
  const { caPath: _existingCaPath, tlsVerify: _existingTlsVerify, ...existingRest } = existing
  const trueconf: Record<string, unknown> = {
    ...existingRest,
    enabled: true,
    serverUrl: values.serverUrl,
    username: values.username,
    password: values.password,
    useTls: values.useTls,
    port: values.port,
    ...(values.setupLocale && { setupLocale: values.setupLocale }),
  }
  if (values.tlsVerify === false) {
    trueconf.tlsVerify = false
  } else if (values.caPath) {
    trueconf.caPath = values.caPath
  }
  return {
    ...cfg,
    channels: {
      ...cfgWithChannels.channels,
      trueconf,
    },
  } as OpenClawConfig
}

// === SDK setup adapter ===
// Consumed by openclaw onboard / channels-list / plugins-setup runtimes via
// plugin.setup. Mirrors signalSetupAdapter (Signal pattern in
// node_modules/openclaw/dist/setup-core-*.js).

function buildTrueconfSetupPatch(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { enabled: true }
  const setIfDefined = (key: string, value: unknown) => {
    if (value === undefined || value === null) return
    if (typeof value === 'string' && value.trim() === '') return
    patch[key] = value
  }
  setIfDefined('serverUrl', input.serverUrl)
  setIfDefined('username', input.username)
  setIfDefined('password', input.password)
  if (typeof input.useTls === 'boolean') patch.useTls = input.useTls
  if (typeof input.port === 'number' && Number.isInteger(input.port) && input.port >= 1 && input.port <= 65535) {
    patch.port = input.port
  }
  setIfDefined('clientId', input.clientId)
  setIfDefined('clientSecret', input.clientSecret)
  setIfDefined('setupLocale', input.setupLocale)
  // Mutual exclusion: tlsVerify === false → drop caPath; else honor caPath.
  if (input.tlsVerify === false) {
    patch.tlsVerify = false
  } else if (typeof input.caPath === 'string' && input.caPath.trim() !== '') {
    patch.caPath = input.caPath
  }
  return patch
}

export const trueconfSetupAdapter: ChannelSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: 'trueconf',
  validateInput: ({ input }) => {
    const inp = input as { serverUrl?: string; username?: string; password?: string }
    const missing: string[] = []
    if (!inp.serverUrl || inp.serverUrl.trim() === '') missing.push('serverUrl')
    if (!inp.username || inp.username.trim() === '') missing.push('username')
    if (!inp.password || (typeof inp.password === 'string' && inp.password.trim() === '')) missing.push('password')
    if (missing.length === 0) return null
    return `TrueConf setup requires: ${missing.join(', ')}`
  },
  buildPatch: (input) => buildTrueconfSetupPatch(input as Record<string, unknown>),
})

// === runWizardAndFinalize ===
// Programmatic wizard-and-finalize orchestrator. The bin's interactive runSetup
// branch and the SDK setup adapter's afterAccountConfigWritten hook both call
// this so neither path duplicates wizard logic.
//
// This helper does NOT touch the filesystem (no read/backup/atomic-write).
// The caller (bin OR onboard) owns those concerns.

export interface RunWizardAndFinalizeArgs {
  cfg: OpenClawConfig
  prompter: SetupPrompter
  wizard: ChannelSetupWizard
  probeModule: ProbeModule
  locale: Locale
  t: TFn
}

export interface RunWizardAndFinalizeResult {
  cfg: OpenClawConfig
  oauthOk: boolean
  savedWithoutValidation: boolean
  caPath?: string
  tlsVerify?: boolean
}

export async function runWizardAndFinalize(args: RunWizardAndFinalizeArgs): Promise<RunWizardAndFinalizeResult> {
  const { prompter, wizard, probeModule, locale, t } = args

  const cfgWithInputs = await promptInteractiveInputs(prompter, wizard, args.cfg, t, locale)
  const { cfg: cfgWithPassword, credentialValues } = await promptPassword(prompter, wizard, cfgWithInputs, t, locale)

  const tcFields = ((cfgWithPassword as { channels?: { trueconf?: Record<string, unknown> } }).channels?.trueconf ?? {}) as {
    serverUrl?: string
    username?: string
    password?: string
    useTls?: boolean
    port?: number
    caPath?: string
  }
  const serverUrl = tcFields.serverUrl
  const username = tcFields.username
  const password = (credentialValues.password as string | undefined) ?? tcFields.password
  if (!serverUrl || !username || !password) {
    throw new Error('Invariant: serverUrl/username/password missing at finalize entry')
  }

  const { useTls, port, caPath, caBytes, tlsVerify } = await promptProbePreview(
    prompter, probeModule, serverUrl, tcFields.useTls, tcFields.port, tcFields.caPath, t, locale,
  )

  let oauthOk = false
  let oauthError: { category: string; error: string } | null = null
  let currentPassword = password

  for (let attempt = 0; attempt < 3 && !oauthOk; attempt++) {
    // tlsVerify:false drops the CA bytes — passing both is a contradictory
    // signal to validateOAuthCredentials and the operator already opted out
    // of pinning when they picked insecure mode.
    // caBytes here originates either from the live `validateCaAgainstServer`
    // chain (already-validated) OR from `readFileSync(caPath)` in the
    // skip-probe short-circuit (operator pinned useTls + port + caPath in
    // their cfg — explicit trust contract, no live validation gate). The
    // ValidatedCaBytes brand exists to enforce the TOCTOU invariant for the
    // FIRST path; the SECOND path is the documented operator-trust escape
    // hatch (mirrors src/channel-setup.ts:31 `markValidated`). Cast through
    // unknown is the project-wide pattern for that escape.
    const ca = tlsVerify === false || !caBytes ? undefined : (caBytes as unknown as ValidatedCaBytes)
    const result = await probeModule.validateOAuthCredentials({
      serverUrl, username, password: currentPassword, useTls, port,
      ca,
      tlsVerify,
    })
    if (result.ok) { oauthOk = true; break }
    oauthError = { category: result.category, error: result.error }
    if (result.category === 'invalid-credentials' && attempt < 2) {
      await prompter.note(t('oauth.invalidPassword', locale, { attempt: attempt + 1 }), t('oauth.title', locale))
      const retry = await prompter.password({ message: t('oauth.passwordRetry', locale) })
      if (typeof retry !== 'string' || retry === '') {
        throw new Error(t('bin.passwordEmpty', locale))
      }
      currentPassword = retry
      continue
    }
    break
  }

  let savedWithoutValidation = false
  let nextCfg: OpenClawConfig

  if (oauthOk) {
    nextCfg = patchChannelWithFinalValues(cfgWithPassword, {
      serverUrl, username, password: currentPassword, useTls, port, caPath, tlsVerify, setupLocale: locale,
    })
  } else {
    // Save-without-validation fallback — invalid-credentials already retried 3×
    // above, so re-throw it; other categories are operator-acknowledged.
    if (!oauthError) throw new Error('Invariant: oauthError missing on !oauthOk')
    const errMsg = `${oauthError.category}: ${oauthError.error}`
    if (oauthError.category === 'invalid-credentials') {
      throw new Error(`OAuth failed (user="${username}", server="${serverUrl}"): ${errMsg}`)
    }
    await prompter.note(
      t('bin.oauth.errorBody', locale, { error: errMsg }),
      t('bin.oauth.errorTitle', locale),
    )
    // Default=true only for `network` (transient/intermittent). For `tls`
    // and `server-error`, retry at gateway startup will hit the same wall.
    const saveAnywayDefault = oauthError.category === 'network'
    const saveAnyway = await prompter.confirm({
      message: t('bin.oauth.saveAnyway', locale),
      initialValue: saveAnywayDefault,
    })
    if (!saveAnyway) {
      throw new Error(`OAuth failed (user="${username}", server="${serverUrl}"): ${errMsg}`)
    }
    nextCfg = patchChannelWithFinalValues(cfgWithPassword, {
      serverUrl, username, password: currentPassword, useTls, port, caPath, tlsVerify, setupLocale: locale,
    })
    savedWithoutValidation = true
  }

  return { cfg: nextCfg, oauthOk, savedWithoutValidation, caPath, tlsVerify }
}
