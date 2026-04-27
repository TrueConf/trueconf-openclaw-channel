import { readFileSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'
import { homedir } from 'node:os'
import type { ChannelSetupWizard, OpenClawConfig, WizardPrompter } from 'openclaw/plugin-sdk/setup'
import {
  patchTopLevelChannelConfigSection,
  hasConfiguredSecretInput,
} from 'openclaw/plugin-sdk/setup'
import { parseCertFromPem, probeTls, downloadCAChain, validateOAuthCredentials, validateCaAgainstServer } from './probe.mjs'
import type { CertSummary, ValidatedCaBytes } from './probe.d.mts'
import { resolveSecret } from './config'
import type { Locale } from './i18n'
import { DEFAULT_LOCALE, t } from './i18n'
import { readTrueConfSection } from './types'

// Read TRUECONF_SETUP_LOCALE env once and validate. Throws if set to anything
// other than 'en'/'ru' so misconfigured CI fails loud instead of silently
// falling back to a default the operator did not pick.
function readEnvLocale(): Locale | undefined {
  const raw = process.env.TRUECONF_SETUP_LOCALE
  if (raw === undefined) return undefined
  if (raw === 'en' || raw === 'ru') return raw
  throw new Error(t('locale.invalidEnv', DEFAULT_LOCALE, { value: raw }))
}

// Brand-mint for CA bytes produced by the TOFU path. The wizard just
// downloaded these from the server and wrote them to disk atomically, so
// they are trust-anchored by construction — no chain validation is possible
// (the anchor IS the server's self-signed cert). Calling this helper makes
// the minting step explicit to reviewers.
function markValidated(bytes: Uint8Array | Buffer): ValidatedCaBytes {
  return bytes as unknown as ValidatedCaBytes
}

const channel = 'trueconf'

export interface Banner {
  title: string
  body: string
}

function formatCertBlock(cert: CertSummary, locale: Locale): string {
  const issuerLine = cert.issuerOrg
    ? `${cert.issuerCN ?? '?'} (${cert.issuerOrg})`
    : (cert.issuerCN ?? '?')
  // The wizard will ultimately fail at validateCaAgainstServer for an expired
  // cert, but the TLS error string is opaque. Surface expiry in the banner so
  // the operator can see WHY their server was rejected before re-running.
  const validToRaw = cert.validTo ?? '?'
  const parsed = cert.validTo ? Date.parse(cert.validTo) : NaN
  const expired = Number.isFinite(parsed) && parsed < Date.now()
  const validToLine = expired
    ? `${validToRaw}  ⚠ ${t('tls.banner.cert.expired', locale)}`
    : validToRaw
  return [
    t('tls.banner.cert.subjectLine', locale, { value: cert.subject ?? '?' }),
    t('tls.banner.cert.issuerLine', locale, { value: issuerLine }),
    t('tls.banner.cert.validityLine', locale, {
      from: cert.validFrom ?? '?',
      to: validToLine,
    }),
    t('tls.banner.cert.fingerprintLine', locale, { fp: cert.fingerprint ?? '?' }),
  ].join('\n')
}

export function buildFreshTofuBanner(cert: CertSummary, locale: Locale): Banner {
  const hint = cert.selfSigned ? t('tls.banner.untrusted.selfSigned', locale) : ''
  const body = [
    t('tls.banner.untrusted.body', locale),
    hint,
    '',
    formatCertBlock(cert, locale),
    '',
    t('tls.banner.untrusted.verifyAdmin', locale),
  ]
    .filter((line) => line !== '')
    .join('\n')
  return { title: t('tls.banner.untrusted.title', locale), body }
}

export function buildMismatchBanner(
  stored: CertSummary | null,
  current: CertSummary | null | undefined,
  caPath: string,
  tlsError: string,
  locale: Locale,
): Banner {
  const storedBlock = stored
    ? formatCertBlock(stored, locale)
    : t('tls.banner.mismatch.storedParseFail', locale)
  const currentBlock = current
    ? formatCertBlock(current, locale)
    : t('tls.banner.cert.noServerCert', locale)
  const body = [
    t('tls.banner.mismatch.body', locale),
    '',
    t('tls.banner.mismatch.storedAnchor', locale, { caPath }),
    storedBlock,
    '',
    t('tls.banner.mismatch.serverNow', locale),
    currentBlock,
    '',
    t('tls.banner.mismatch.tlsStack', locale, { error: tlsError }),
    t('tls.banner.mismatch.chainBroken', locale),
    '',
    t('tls.banner.mismatch.causes', locale),
  ].join('\n')
  return { title: t('tls.banner.mismatch.title', locale), body }
}

export function buildConfigMissingBanner(
  caPath: string,
  reason: string,
  currentCert: CertSummary | null | undefined,
  locale: Locale,
): Banner {
  const certBlock = currentCert
    ? formatCertBlock(currentCert, locale)
    : t('tls.banner.cert.noServerCert', locale)
  const body = [
    t('tls.banner.missing.body', locale),
    '',
    t('tls.banner.missing.expected', locale, { caPath }),
    t('tls.banner.missing.status', locale, { reason }),
    '',
    t('tls.banner.missing.serverNow', locale),
    certBlock,
    '',
    t('tls.banner.missing.causes', locale),
    '',
    t('tls.banner.missing.verifyAdmin', locale),
  ].join('\n')
  return { title: t('tls.banner.missing.title', locale), body }
}

export const trueconfSetupWizard: ChannelSetupWizard = {
  channel,

  status: {
    configuredLabel: 'TrueConf: подключён',
    unconfiguredLabel: 'TrueConf: нужны креды',
    configuredHint: 'configured',
    unconfiguredHint: 'needs bot credentials',
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => {
      const tc = readTrueConfSection(cfg)
      return Boolean(
        tc.serverUrl &&
          tc.username &&
          hasConfiguredSecretInput(tc.password),
      )
    },
  },

  introNote: {
    title: 'Подключение к TrueConf',
    lines: [
      'Вам потребуется адрес сервера, логин и пароль бота.',
    ],
  },

  envShortcut: {
    prompt: 'TRUECONF_SERVER_URL/USERNAME/PASSWORD обнаружены — настроить автоматически?',
    preferredEnvVar: 'TRUECONF_PASSWORD',
    isAvailable: () =>
      Boolean(
        process.env.TRUECONF_SERVER_URL?.trim() &&
          process.env.TRUECONF_USERNAME?.trim() &&
          process.env.TRUECONF_PASSWORD?.trim(),
      ),
    apply: async ({ cfg }) => runHeadlessFinalize(cfg),
  },

  textInputs: [
    {
      inputKey: 'serverUrl' as never,
      message: 'URL TrueConf Server',
      placeholder: 'tc.example.com',
      required: true,
      currentValue: ({ cfg }) => readTrueConfSection(cfg).serverUrl,
      validate: ({ value }) => {
        if (value.includes('://')) return 'Укажите хост без http(s)://'
        if (/:\d+$/.test(value)) return 'Укажите хост без :порта — порт задаётся отдельным полем'
        return undefined
      },
      applySet: ({ cfg, value }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          patch: { serverUrl: value.trim() },
        }),
    },
    {
      inputKey: 'username' as never,
      message: 'Логин бота (только имя, без @сервер)',
      placeholder: 'bot_user',
      required: true,
      currentValue: ({ cfg }) => readTrueConfSection(cfg).username,
      applySet: ({ cfg, value }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          patch: { username: value.trim() },
        }),
    },
    {
      inputKey: 'useTls' as never,
      message: 'TLS? (пусто = авто-детект)',
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg }) => {
        const tls = readTrueConfSection(cfg).useTls
        return tls === undefined ? '' : String(tls)
      },
      normalizeValue: ({ value }) =>
        value === '' ? '' : value === 'true' ? 'true' : 'false',
      applySet: ({ cfg, value }) => {
        if (value === '') return cfg
        return patchTopLevelChannelConfigSection({
          cfg,
          channel,
          patch: { useTls: value === 'true' },
        })
      },
    },
    {
      inputKey: 'port' as never,
      message: 'Порт (пусто = scheme default 4309/443)',
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg }) => readTrueConfSection(cfg).port?.toString(),
      validate: ({ value }) => {
        if (value === '') return
        const n = Number.parseInt(value, 10)
        return Number.isFinite(n) && n > 0 && n < 65536 ? undefined : 'Невалидный порт'
      },
      applySet: ({ cfg, value }) => {
        if (value === '') return cfg
        return patchTopLevelChannelConfigSection({
          cfg,
          channel,
          patch: { port: Number.parseInt(value, 10) },
        })
      },
    },
  ],

  credentials: [
    {
      inputKey: 'password' as never,
      providerHint: 'trueconf',
      credentialLabel: 'Пароль бота',
      preferredEnvVar: 'TRUECONF_PASSWORD',
      envPrompt: 'Использовать TRUECONF_PASSWORD из окружения?',
      keepPrompt: 'Пароль TrueConf уже задан. Оставить?',
      inputPrompt: 'Введите пароль бота',
      allowEnv: () => Boolean(process.env.TRUECONF_PASSWORD?.trim()),
      inspect: ({ cfg }) => {
        const pwd = readTrueConfSection(cfg).password
        return {
          accountConfigured: hasConfiguredSecretInput(pwd),
          hasConfiguredValue: hasConfiguredSecretInput(pwd),
          envValue: process.env.TRUECONF_PASSWORD,
        }
      },
      applyUseEnv: ({ cfg }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          patch: { password: { useEnv: 'TRUECONF_PASSWORD' } },
        }),
      applySet: ({ cfg, value }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          patch: { password: String(value) },
        }),
    },
  ],
  stepOrder: 'text-first',

  finalize: (params) => interactiveFinalize(params),

  completionNote: {
    title: 'Готово',
    lines: [
      'Канал TrueConf настроен.',
      'Запустить: openclaw gateway',
    ],
  },
}

function resolveAbsPath(raw: string): string {
  const expanded = raw.startsWith('~/') || raw === '~'
    ? raw.replace(/^~/, homedir())
    : raw
  return pathResolve(expanded)
}

// Shared env-CA validation for interactive and headless finalize paths.
// Both need the same sequence (read → parse → validate-against-server) with
// the same error copy — keeping this in one place prevents the two throws
// from drifting as we tune the operator-facing messaging.
async function loadAndValidateEnvCa(args: {
  envPath: string
  host: string
  port: number
  locale: Locale
}): Promise<{ abs: string; caBytes: ValidatedCaBytes }> {
  const { locale } = args
  const abs = resolveAbsPath(args.envPath)
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch (err) {
    throw new Error(t('tls.cafile.envUnreadable', locale, { path: abs, reason: (err as Error).message }))
  }
  const cert = parseCertFromPem(bytes)
  if (!cert) {
    throw new Error(t('tls.cafile.envNotPem', locale, { path: abs }))
  }
  const v = await validateCaAgainstServer({ caBytes: bytes, host: args.host, port: args.port })
  if (!v.ok) {
    if (v.kind === 'unreachable') {
      throw new Error(t('tls.cafile.envUnreachable', locale, {
        path: abs,
        host: args.host,
        port: args.port,
        error: v.error,
      }))
    }
    throw new Error(t('tls.cafile.envWrongCa', locale, {
      path: abs,
      fileIssuer: cert.issuerCN ?? cert.subject ?? '?',
      serverIssuer: v.serverCert?.issuerCN ?? '?',
      error: v.error,
    }))
  }
  return { abs, caBytes: v.caBytes }
}

function shortFp(fp: string | null | undefined): string {
  if (!fp) return '?'
  return fp.length > 29 ? `${fp.slice(0, 29)}…` : fp
}

const MAX_CA_FILE_ATTEMPTS = 3

async function readCaFileInteractive(args: {
  prompter: WizardPrompter
  host: string
  port: number
  locale: Locale
}): Promise<{ nextCaPath: string; nextCaBytes: ValidatedCaBytes }> {
  const { prompter, host, port, locale } = args
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
    const cert = parseCertFromPem(bytes)
    if (!cert) {
      const reason = `${abs}: не PEM`
      reasons.push(reason)
      await prompter.note(
        t('cafile.notPem', locale),
        t('cafile.title', locale),
      )
      continue
    }
    const v = await validateCaAgainstServer({ caBytes: bytes, host, port })
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

// Downloads the server's current cert chain as the new trust anchor and
// writes an audit line to stderr naming the host, port, subject, and
// fingerprint we just pinned. Centralizes the audit trail so every TOFU
// path emits the same record. TOFU is inherently trust-on-first-use, so
// this line is the only post-facto evidence of what was accepted.
async function downloadAndAudit(args: {
  host: string
  port: number
  mode: 'fresh-tofu' | 're-tofu' | 'accept-new' | 'headless-auto'
  // What the user saw in the banner before choosing to TOFU. If set and the
  // downloaded cert's fingerprint differs, we hit the TOCTOU-rotation path.
  expected?: CertSummary | null
  // Interactive confirm channel. Absent in headless.
  prompter?: WizardPrompter
  // Headless override: accept rotation unattended (CI / bootstrap).
  acceptRotated?: boolean
  // Locale for the rotation prompt. Headless callers pass DEFAULT_LOCALE.
  locale: Locale
}): Promise<{ nextCaPath: string; nextCaBytes: ValidatedCaBytes }> {
  const { host, port, mode, expected, prompter, acceptRotated, locale } = args
  const { path: ca, bytes } = await downloadCAChain({ host, port })
  const cert = parseCertFromPem(bytes)

  // TOCTOU check: the cert the server presented during downloadCAChain may
  // differ from the one the user saw in the banner (narrow window — the
  // seconds between the initial probe and the TOFU handshake). Catch the
  // rotation so an attacker can't flip the anchor under the user's feet.
  const expFp = expected?.fingerprint ?? null
  const gotFp = cert?.fingerprint ?? null
  if (expFp && gotFp && expFp !== gotFp) {
    const diff = t('rotation.body', locale, {
      expectedSubject: expected?.subject ?? '?',
      expectedFp: expFp,
      gotSubject: cert?.subject ?? '?',
      gotFp,
    })
    if (prompter) {
      await prompter.note(diff, t('rotation.title', locale))
      const confirmed = await prompter.confirm({
        message: t('rotation.confirm', locale),
        initialValue: false,
      })
      if (!confirmed) {
        throw new Error(
          `Cert rotation detected mid-flow on ${host}:${port} ` +
          `(banner=${expFp.slice(0, 29)}… downloaded=${gotFp.slice(0, 29)}…). ` +
          `User declined to pin the rotated cert.`,
        )
      }
    } else if (!acceptRotated) {
      throw new Error(
        `Cert rotation detected mid-flow on ${host}:${port} ` +
        `(banner=${expFp} downloaded=${gotFp}). ` +
        `Set TRUECONF_ACCEPT_ROTATED_CERT=true to accept rotations unattended.`,
      )
    }
  }

  process.stderr.write(
    `[trueconf-setup] trusted via ${mode}: ${host}:${port} ` +
    `subject=${cert?.subject ?? '?'} ` +
    `issuer=${cert?.issuerCN ?? '?'} ` +
    `fingerprint=${cert?.fingerprint ?? '?'}\n`,
  )
  return { nextCaPath: ca, nextCaBytes: markValidated(bytes) }
}

async function handleUntrustedCert(args: {
  prompter: WizardPrompter
  host: string
  port: number
  existingCaPath: string | undefined
  currentCert: CertSummary | undefined
  locale: Locale
}): Promise<{ nextCaPath?: string; nextCaBytes?: ValidatedCaBytes; tlsVerify?: boolean }> {
  const { prompter, host, port, existingCaPath, currentCert, locale } = args

  if (existingCaPath) {
    const resolved = resolveAbsPath(existingCaPath)
    let storedBytes: Buffer | null = null
    let readErr: NodeJS.ErrnoException | null = null
    try {
      storedBytes = readFileSync(resolved)
    } catch (err) {
      readErr = err as NodeJS.ErrnoException
    }

    if (!storedBytes) {
      const reason = readErr?.code === 'ENOENT'
        ? t('tls.banner.missing.reasonAbsent', locale)
        : t('tls.banner.missing.reasonReadErr', locale, { message: readErr?.message ?? 'unknown' })
      const banner = buildConfigMissingBanner(
        resolved,
        reason,
        currentCert ?? null,
        locale,
      )
      await prompter.note(banner.body, banner.title)
      const choice = await prompter.select<string>({
        message: t('select.whatToDo', locale),
        options: [
          { value: 'abort',    label: t('select.option.abort', locale) },
          { value: 're-tofu',  label: t('select.option.reTofu', locale) },
          { value: 'use-file', label: t('select.option.useFile', locale) },
        ],
      })
      if (choice === 'abort') {
        throw new Error(`User aborted: configured caPath missing (${resolved})`)
      }
      if (choice === 're-tofu') {
        return await downloadAndAudit({
          host,
          port,
          mode: 're-tofu',
          expected: currentCert ?? null,
          prompter,
          locale,
        })
      }
      return await readCaFileInteractive({ prompter, host, port, locale })
    }

    const v = await validateCaAgainstServer({ caBytes: storedBytes, host, port })
    if (v.ok) {
      return { nextCaPath: resolved, nextCaBytes: v.caBytes }
    }

    // Unreachable is NOT a trust mismatch — avoid shoving the user into an
    // accept-new/use-file dialog for what is likely a transient network issue.
    if (v.kind === 'unreachable') {
      throw new Error(
        `Could not reach ${host}:${port} to re-validate stored CA (${v.error}). ` +
        `Check network / DNS / firewall and re-run setup.`,
      )
    }

    const storedCert = parseCertFromPem(storedBytes)
    const banner = buildMismatchBanner(storedCert, currentCert ?? null, resolved, v.error, locale)
    await prompter.note(banner.body, banner.title)
    const choice = await prompter.select<string>({
      message: t('select.whatToDo', locale),
      options: [
        { value: 'abort',      label: t('select.option.abort', locale) },
        { value: 'accept-new', label: t('select.option.acceptNew', locale) },
        { value: 'use-file',   label: t('select.option.useFileFromAdmin', locale) },
      ],
    })
    if (choice === 'abort') {
      throw new Error(`User aborted after trust mismatch on ${host} (caPath=${resolved})`)
    }
    if (choice === 'accept-new') {
      return await downloadAndAudit({
        host,
        port,
        mode: 'accept-new',
        expected: currentCert ?? null,
        prompter,
        locale,
      })
    }
    return await readCaFileInteractive({ prompter, host, port, locale })
  }

  // Fresh untrusted cert (no prior caPath). Two safe paths only: pin a CA file
  // the admin provided, or explicitly disable TLS verification for this
  // TrueConf account. The legacy auto-download path is intentionally absent
  // from this menu — it is reachable only as recovery for an existing caPath
  // (re-tofu / accept-new branches above).
  if (!currentCert) {
    throw new Error(`Untrusted TLS on ${host} but server returned no certificate — cannot prompt for untrusted-cert flow`)
  }
  const banner = buildFreshTofuBanner(currentCert, locale)
  await prompter.note(banner.body, banner.title)
  const choice = await prompter.select<string>({
    message: t('select.whatToDo', locale),
    options: [
      { value: 'use-file', label: t('tls.untrusted.choice.use-file', locale) },
      { value: 'insecure', label: t('tls.untrusted.choice.insecure', locale) },
      { value: 'abort',    label: t('select.option.abortSetup', locale) },
    ],
  })
  if (choice === 'abort') {
    throw new Error(`User aborted: untrusted cert on ${host}`)
  }
  if (choice === 'insecure') {
    await prompter.note(t('tls.insecure.warning', locale), t('tls.untrusted.title', locale))
    const confirmed = await prompter.confirm({
      message: t('tls.insecure.confirm', locale),
      initialValue: false,
    })
    if (!confirmed) {
      throw new Error(`User declined to disable TLS verification on ${host}`)
    }
    return { tlsVerify: false }
  }
  return await readCaFileInteractive({ prompter, host, port, locale })
}

export async function interactiveFinalize(params: {
  cfg: OpenClawConfig
  prompter: WizardPrompter
  credentialValues: Partial<Record<string, string>>
  accountId: string
  runtime?: unknown
  options?: unknown
  forceAllowFrom: boolean
}): Promise<{ cfg: OpenClawConfig }> {
  const { cfg, prompter, credentialValues } = params
  const tc = readTrueConfSection(cfg)

  // Resolve locale before any prompter call. Precedence: env > cfg > prompt.
  // Env raw-read here (not via resolveAccount) to keep the precedence check
  // simple and avoid threading through normalize().
  const envLocale = readEnvLocale()
  let locale: Locale
  if (envLocale) {
    locale = envLocale
  } else if (tc.setupLocale === 'en' || tc.setupLocale === 'ru') {
    locale = tc.setupLocale
  } else {
    const picked = await prompter.select<Locale>({
      message: t('language.prompt', DEFAULT_LOCALE),
      options: [
        { value: 'en', label: t('language.option.en', DEFAULT_LOCALE) },
        { value: 'ru', label: t('language.option.ru', DEFAULT_LOCALE) },
      ],
    })
    locale = picked === 'ru' ? 'ru' : 'en'
  }

  const serverUrl = tc.serverUrl
  const username = tc.username
  const password = credentialValues.password ?? resolveSecret(tc.password)

  if (!serverUrl || !username || !password) {
    throw new Error('Wizard invariant: required fields missing at finalize entry')
  }

  let useTls: boolean | undefined = tc.useTls
  let port: number | undefined = tc.port
  let caPath: string | undefined
  let caBytes: ValidatedCaBytes | undefined
  // tlsVerify is undefined unless the user explicitly picks insecure mode
  // below. Default-undefined means "verify via system trust or pinned CA";
  // only literal `false` opts out, matching the runtime resolver in
  // src/config.ts that requires `tlsVerify === false` to disable verification.
  let tlsVerify: boolean | undefined

  // STEP 1 — explicit env override takes precedence over probe + stored CA.
  // Rationale: operators bootstrapping via CI / Ansible / Kubernetes need a
  // deterministic trust path that doesn't depend on any UI interaction, and
  // that wins over whatever is currently on disk.
  const envPath = process.env.TRUECONF_CA_PATH?.trim()
  if (envPath) {
    const loaded = await loadAndValidateEnvCa({ envPath, host: serverUrl, port: port ?? 443, locale })
    useTls = true
    port = port ?? 443
    caPath = loaded.abs
    caBytes = loaded.caBytes
  } else if (useTls !== false) {
    // STEP 2 — probe every run. A fresh probe is what makes re-validation work:
    // on re-setup with a stored caPath, `probe.caUntrusted` fires when the
    // server cert has rotated or been MITM'd, routing us into the mismatch
    // branch in handleUntrustedCert. First-setup path uses the same probe.
    await prompter.note(t('probe.detecting', locale), t('probe.title', locale))
    const probe = await probeTls({ host: serverUrl, port })
    if (!probe.reachable) {
      await prompter.note(
        t('probe.skipped', locale, { error: probe.error ?? 'unknown' }),
        t('probe.skippedTitle', locale),
      )
      useTls = true
      port = port ?? 443
    } else {
      useTls = probe.useTls
      port = port ?? probe.port
      if (probe.caUntrusted && useTls) {
        // STEP 3 — branch into the untrusted-cert UX only when the probe
        // actually saw an untrusted cert. A trusted cert means system-CAs
        // already cover it, so we skip pinning entirely and fall through to
        // OAuth. The handler may return a CA file (legacy/use-file paths) or
        // a tlsVerify:false opt-out (new fresh-untrusted insecure choice).
        const decision = await handleUntrustedCert({
          prompter,
          host: serverUrl,
          port: port!,
          existingCaPath: tc.caPath,
          currentCert: probe.cert,
          locale,
        })
        caPath = decision.nextCaPath
        caBytes = decision.nextCaBytes
        tlsVerify = decision.tlsVerify
      }
    }
  }

  // OAuth validation loop. Invariant: the CA bytes handed to
  // validateOAuthCredentials are the ones we just validated in-process;
  // never re-read from disk between validate and use.
  let currentPassword = password
  let validated = false
  for (let attempt = 0; attempt < 3 && !validated; attempt++) {
    // tlsVerify:false means the user opted out of cert verification entirely
    // for this account, so do NOT pass `ca` even if some prior step left bytes
    // around — the dispatcher would just ignore them, and shipping both is a
    // contradictory signal to readers.
    const result = await validateOAuthCredentials({
      serverUrl,
      username,
      password: currentPassword,
      useTls,
      port,
      ca: tlsVerify === false ? undefined : caBytes,
      tlsVerify,
    })
    if (result.ok) {
      validated = true
      break
    }

    if (result.category === 'invalid-credentials' && attempt < 2) {
      await prompter.note(
        t('oauth.invalidPassword', locale, { attempt: attempt + 1 }),
        t('oauth.title', locale),
      )
      currentPassword = String(await prompter.text({
        message: t('oauth.passwordRetry', locale),
      }))
      continue
    }

    await prompter.note(
      t('oauth.error', locale, { error: result.error }),
      t('oauth.errorTitle', locale),
    )
    throw new Error(`OAuth failed (user="${username}", server="${serverUrl}"): ${result.category}: ${result.error}`)
  }

  // Clear stale trust-mode fields based on the path we took. Mutually
  // exclusive: useTls:false drops both caPath+tlsVerify (no TLS = no trust
  // anchor); strict CA / system trust drops tlsVerify (we are verifying);
  // insecure (tlsVerify:false) drops caPath (we are not pinning).
  const clearFields: string[] = []
  if (useTls === false) {
    clearFields.push('caPath', 'tlsVerify')
  } else if (tlsVerify === false) {
    clearFields.push('caPath')
  } else {
    clearFields.push('tlsVerify')
  }

  const nextCfg = patchTopLevelChannelConfigSection({
    cfg,
    channel,
    enabled: true,
    clearFields,
    patch: {
      ...(useTls !== undefined && { useTls }),
      ...(port !== undefined && { port }),
      ...(useTls !== false && caPath !== undefined && { caPath }),
      ...(tlsVerify === false && { tlsVerify: false }),
      password: currentPassword,
      setupLocale: locale,
    },
  })

  await prompter.note(
    t('connected.body', locale, { username }),
    t('connected.title', locale),
  )
  return { cfg: nextCfg }
}

// Env-driven headless finalize. Reads TRUECONF_SERVER_URL/USERNAME/PASSWORD
// (and optional TRUECONF_USE_TLS/PORT), probes TLS when not pinned, validates
// OAuth once (no retry — fail fast in CI/bootstrap contexts), and returns a
// patched cfg with channels.trueconf filled in. Exported for integration tests.
export async function runHeadlessFinalize(cfg: OpenClawConfig): Promise<OpenClawConfig> {
  const cfgTc = readTrueConfSection(cfg)

  // Resolve locale at top of function. Headless never prompts; if neither env
  // nor cfg sets it, fall back to DEFAULT_LOCALE ('en'). Invalid env throws.
  const envLocale = readEnvLocale()
  const locale: Locale = envLocale
    ?? (cfgTc.setupLocale === 'en' || cfgTc.setupLocale === 'ru' ? cfgTc.setupLocale : DEFAULT_LOCALE)

  const serverUrl = process.env.TRUECONF_SERVER_URL?.trim()
  const username = process.env.TRUECONF_USERNAME?.trim()
  const password = process.env.TRUECONF_PASSWORD?.trim()
  if (!serverUrl || !username || !password) {
    throw new Error(
      'runHeadlessFinalize requires TRUECONF_SERVER_URL, TRUECONF_USERNAME, TRUECONF_PASSWORD',
    )
  }

  const useTlsEnv = process.env.TRUECONF_USE_TLS
  const useTlsHint: boolean | undefined =
    useTlsEnv === 'true' ? true : useTlsEnv === 'false' ? false : undefined
  const portEnv = process.env.TRUECONF_PORT
  const portHint: number | undefined = portEnv ? Number.parseInt(portEnv, 10) : undefined

  let resolvedUseTls = useTlsHint
  let resolvedPort = portHint
  let caPath: string | undefined
  let caBytes: ValidatedCaBytes | undefined
  let tlsVerify: boolean | undefined

  const envCaPath = process.env.TRUECONF_CA_PATH?.trim()
  const envTlsVerify = process.env.TRUECONF_TLS_VERIFY?.trim()

  // Operator-acknowledged insecure mode via env. Only `'false'` or unset
  // are accepted — `'true'`/anything else throws so a typo doesn't silently
  // fall through to strict mode under the wrong assumption. Conflict with
  // TRUECONF_CA_PATH is fatal: pinning a CA AND skipping verification is
  // contradictory operator intent and we'd rather refuse than guess.
  if (envTlsVerify !== undefined && envTlsVerify !== '') {
    if (envTlsVerify !== 'false') {
      throw new Error(t('tls.insecure.invalidEnv', locale, { value: envTlsVerify }))
    }
    if (envCaPath) {
      throw new Error(t('tls.insecure.conflict', locale))
    }
    if (useTlsHint === false || (useTlsHint !== true && cfgTc.useTls === false)) {
      throw new Error(t('tls.insecure.useTlsConflict', locale))
    }
    tlsVerify = false
    resolvedUseTls = true
    resolvedPort = resolvedPort ?? 443
  }

  // 1) Explicit CA env override takes precedence (skipped when in insecure mode)
  if (tlsVerify !== false && envCaPath) {
    const loaded = await loadAndValidateEnvCa({
      envPath: envCaPath,
      host: serverUrl,
      port: resolvedPort ?? 443,
      locale,
    })
    resolvedUseTls = true
    resolvedPort = resolvedPort ?? 443
    caPath = loaded.abs
    caBytes = loaded.caBytes
  } else if (tlsVerify !== false) {
    // 2) Check configured caPath in current cfg (skipped in insecure mode)
    const existing = cfgTc.caPath

    if (existing) {
      const abs = resolveAbsPath(existing)
      let bytes: Buffer | null = null
      try {
        bytes = readFileSync(abs)
      } catch (err) {
        throw new Error(
          `Configured caPath ${abs} not readable (${(err as Error).message}). ` +
          `Remove it from config and re-run setup to re-TOFU, or set TRUECONF_CA_PATH to override.`,
        )
      }
      const v = await validateCaAgainstServer({ caBytes: bytes, host: serverUrl, port: resolvedPort ?? 443 })
      if (!v.ok) {
        if (v.kind === 'unreachable') {
          throw new Error(
            `Could not reach ${serverUrl}:${resolvedPort ?? 443} to re-validate stored CA (${v.error}). ` +
            `Check network / DNS / firewall and retry.`,
          )
        }
        throw new Error(
          `Stored CA no longer validates server ${serverUrl} ` +
          `(TLS error: ${v.error}). ` +
          `Server now presents cert issued by ${v.serverCert?.issuerCN ?? '?'}. ` +
          `Remove ${abs} and re-run setup to re-TOFU, or set TRUECONF_CA_PATH to provide correct CA.`,
        )
      }
      resolvedUseTls = true
      resolvedPort = resolvedPort ?? 443
      caPath = abs
      caBytes = v.caBytes
    } else if (resolvedUseTls === undefined) {
      // 3) No override, no configured caPath → raw probe
      const probe = await probeTls({ host: serverUrl, port: resolvedPort })
      if (probe.reachable) {
        resolvedUseTls = probe.useTls
        resolvedPort = resolvedPort ?? probe.port
        if (probe.caUntrusted) {
          if (process.env.TRUECONF_ACCEPT_UNTRUSTED_CA !== 'true') {
            throw new Error(
              'Self-signed / untrusted cert detected; set TRUECONF_ACCEPT_UNTRUSTED_CA=true to auto-download chain, or set TRUECONF_CA_PATH to point to the admin-provided CA file.',
            )
          }
          const dl = await downloadAndAudit({
            host: serverUrl,
            port: resolvedPort,
            mode: 'headless-auto',
            expected: probe.cert ?? null,
            acceptRotated: process.env.TRUECONF_ACCEPT_ROTATED_CERT === 'true',
            locale,
          })
          caPath = dl.nextCaPath
          caBytes = dl.nextCaBytes
        }
      } else {
        resolvedUseTls = true
        resolvedPort = resolvedPort ?? 443
        process.stderr.write(
          `[trueconf-setup] TLS probe failed (${probe.error ?? 'unknown'}); defaulting to HTTPS:443\n`,
        )
      }
    }
  }

  const result = await validateOAuthCredentials({
    serverUrl,
    username,
    password,
    useTls: resolvedUseTls,
    port: resolvedPort,
    // Insecure mode discards any stale ca bytes — verifier must see a clean
    // "no trust anchor + skip verification" call so behavior matches the
    // wizard's interactive insecure path.
    ca: tlsVerify === false ? undefined : caBytes,
    tlsVerify,
  })
  if (!result.ok) {
    throw new Error(`OAuth failed (user="${username}", server="${serverUrl}"): ${result.category}: ${result.error}`)
  }

  // Same three-mode mutual-exclusion rule as interactiveFinalize: useTls:false
  // drops both trust knobs, insecure drops caPath (and sets tlsVerify), strict
  // drops tlsVerify.
  const clearFields: string[] = []
  if (resolvedUseTls === false) {
    clearFields.push('caPath', 'tlsVerify')
  } else if (tlsVerify === false) {
    clearFields.push('caPath')
  } else {
    clearFields.push('tlsVerify')
  }

  return patchTopLevelChannelConfigSection({
    cfg,
    channel,
    enabled: true,
    clearFields,
    patch: {
      serverUrl,
      username,
      password,
      setupLocale: locale,
      ...(resolvedUseTls !== undefined && { useTls: resolvedUseTls }),
      ...(resolvedPort !== undefined && { port: resolvedPort }),
      ...(tlsVerify === false && { tlsVerify: false }),
      ...(resolvedUseTls !== false && tlsVerify !== false && caPath !== undefined && { caPath }),
    },
  })
}
