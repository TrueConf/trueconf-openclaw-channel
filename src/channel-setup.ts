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

function formatCertBlock(cert: CertSummary): string {
  const issuerLine = cert.issuerOrg
    ? `${cert.issuerCN ?? '?'} (${cert.issuerOrg})`
    : (cert.issuerCN ?? '?')
  // The wizard will ultimately fail at validateCaAgainstServer for an expired
  // cert, but the TLS error string is opaque. Surface expiry in the banner so
  // the operator can see WHY their server was rejected before re-running.
  const validToRaw = cert.validTo ?? '?'
  const parsed = cert.validTo ? Date.parse(cert.validTo) : NaN
  const expired = Number.isFinite(parsed) && parsed < Date.now()
  const validToLine = expired ? `${validToRaw}  ⚠ ПРОСРОЧЕН` : validToRaw
  return [
    `  Владелец:     ${cert.subject ?? '?'}`,
    `  Издатель:     ${issuerLine}`,
    `  Действителен: с ${cert.validFrom ?? '?'} до ${validToLine}`,
    `  Отпечаток:    SHA-256 ${cert.fingerprint ?? '?'}`,
  ].join('\n')
}

export function buildFreshTofuBanner(cert: CertSummary): Banner {
  const hint = cert.selfSigned
    ? '  (самоподписан — типично для dev/тестовых серверов)\n'
    : ''
  const body = [
    '⚠ Сертификат TLS не в системном хранилище доверенных',
    hint.trimEnd(),
    '',
    formatCertBlock(cert),
    '',
    '  Сверьте отпечаток с админом сервера по отдельному каналу',
    '  (мессенджер, телефон), затем выберите действие.',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
  return { title: 'Подтверждение cert TrueConf', body }
}

export function buildMismatchBanner(
  stored: CertSummary | null,
  current: CertSummary | null | undefined,
  caPath: string,
  tlsError: string,
): Banner {
  const storedBlock = stored ? formatCertBlock(stored) : '  (не удалось распарсить сохранённую цепочку)'
  const currentBlock = current ? formatCertBlock(current) : '  (сервер не отдал cert)'
  const body = [
    '⚠⚠ ВНИМАНИЕ: сохранённый trust anchor больше не валидирует сервер',
    '',
    `Сохранённый trust anchor (файл: ${caPath}):`,
    storedBlock,
    '',
    'Сервер, подписанный сейчас (leaf):',
    currentBlock,
    '',
    `TLS-стек: ${tlsError}`,
    '(цепочка доверия от текущего cert\'а к сохранённому anchor\'у не собирается)',
    '',
    'Возможные причины:',
    '  • смена internal CA сервера — уточни у админа;',
    '  • атака «человек посередине» — сверь новый отпечаток',
    '    с админом по отдельному каналу перед принятием.',
  ].join('\n')
  return { title: 'Trust anchor mismatch', body }
}

export function buildConfigMissingBanner(
  caPath: string,
  reason: string,
  currentCert: CertSummary | null | undefined,
): Banner {
  const certBlock = currentCert ? formatCertBlock(currentCert) : '  (сервер не отдал cert)'
  const body = [
    '⚠ Файл сохранённого trust anchor\'а не найден/не читается',
    '',
    `Ожидалось:  ${caPath}`,
    `Статус:     ${reason}`,
    '',
    'Сервер сейчас отдаёт untrusted сертификат:',
    certBlock,
    '',
    'Возможные причины:',
    '  • файл удалён вами или админом (плановая очистка);',
    '  • файл удалён злоумышленником чтобы форсировать re-TOFU',
    '    на (возможно) подменённый cert;',
    '  • permission errors после cleanup / upgrade.',
    '',
    'Сверьте отпечаток сервера с админом ДО re-TOFU.',
  ].join('\n')
  return { title: 'Missing trust anchor', body }
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
      const tc = (cfg as { channels?: { trueconf?: { serverUrl?: string; username?: string; password?: unknown } } })
        .channels?.trueconf
      return Boolean(
        tc?.serverUrl &&
          tc?.username &&
          hasConfiguredSecretInput(tc?.password),
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
      currentValue: ({ cfg }) =>
        (cfg as { channels?: { trueconf?: { serverUrl?: string } } }).channels?.trueconf?.serverUrl,
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
      currentValue: ({ cfg }) =>
        (cfg as { channels?: { trueconf?: { username?: string } } }).channels?.trueconf?.username,
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
        const tls = (cfg as { channels?: { trueconf?: { useTls?: boolean } } }).channels?.trueconf?.useTls
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
      currentValue: ({ cfg }) =>
        (cfg as { channels?: { trueconf?: { port?: number } } }).channels?.trueconf?.port?.toString(),
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
        const pwd = (cfg as { channels?: { trueconf?: { password?: unknown } } }).channels?.trueconf?.password
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
}): Promise<{ abs: string; caBytes: ValidatedCaBytes }> {
  const abs = resolveAbsPath(args.envPath)
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch (err) {
    throw new Error(`TRUECONF_CA_PATH=${abs}: не могу прочитать (${(err as Error).message})`)
  }
  const cert = parseCertFromPem(bytes)
  if (!cert) {
    throw new Error(
      `TRUECONF_CA_PATH=${abs}: не PEM. DER/P7B не поддерживаются — ` +
      `конвертируй: openssl x509 -in file -inform DER -out file.pem`,
    )
  }
  const v = await validateCaAgainstServer({ caBytes: bytes, host: args.host, port: args.port })
  if (!v.ok) {
    if (v.kind === 'unreachable') {
      throw new Error(
        `TRUECONF_CA_PATH=${abs}: не могу подключиться к ${args.host}:${args.port} — ${v.error}. ` +
        `CA не проверить пока сервер недоступен.`,
      )
    }
    throw new Error(
      `TRUECONF_CA_PATH=${abs}: файл не валидирует этот сервер. ` +
      `Trust anchor в файле: ${cert.issuerCN ?? cert.subject ?? '?'}; ` +
      `сервер отдаёт cert с издателем ${v.serverCert?.issuerCN ?? '?'}. ` +
      `TLS error: ${v.error}`,
    )
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
}): Promise<{ nextCaPath: string; nextCaBytes: ValidatedCaBytes }> {
  const { prompter, host, port } = args
  const reasons: string[] = []
  for (let attempt = 0; attempt < MAX_CA_FILE_ATTEMPTS; attempt++) {
    const rawPath = String(await prompter.text({
      message: 'Путь к файлу сертификата (PEM):',
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
      const reason = `${abs}: не могу прочитать (${(err as Error).message})`
      reasons.push(reason)
      await prompter.note(reason, 'CA file input')
      continue
    }
    const cert = parseCertFromPem(bytes)
    if (!cert) {
      const reason = `${abs}: не PEM`
      reasons.push(reason)
      await prompter.note(
        'Файл не PEM. DER/P7B не поддерживаются — конвертируй: openssl x509 -in cert.der -inform DER -out cert.pem',
        'CA file input',
      )
      continue
    }
    const v = await validateCaAgainstServer({ caBytes: bytes, host, port })
    if (!v.ok) {
      if (v.kind === 'unreachable') {
        reasons.push(`${abs}: server unreachable (${v.error})`)
        await prompter.note(
          `Не могу подключиться к ${host}:${port} — ${v.error}.\nCA-файл не проверить пока сервер недоступен. Проверь сеть/DNS/firewall и повтори.`,
          'CA file input',
        )
      } else {
        reasons.push(`${abs}: chain mismatch (${v.error})`)
        await prompter.note(
          [
            'Файл не валидирует этот сервер:',
            `  Trust anchor в файле: ${cert.issuerCN ?? cert.subject ?? '?'} (отпечаток ${shortFp(cert.fingerprint)})`,
            `  Сервер подписан: ${v.serverCert?.issuerCN ?? v.serverCert?.subject ?? '?'} (отпечаток ${shortFp(v.serverCert?.fingerprint)})`,
            '  Возможно: не тот файл / не тот сервер / chain не полный.',
            `  TLS-стек: ${v.error}`,
          ].join('\n'),
          'CA file input',
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
}): Promise<{ nextCaPath: string; nextCaBytes: ValidatedCaBytes }> {
  const { host, port, mode, expected, prompter, acceptRotated } = args
  const { path: ca, bytes } = await downloadCAChain({ host, port })
  const cert = parseCertFromPem(bytes)

  // TOCTOU check: the cert the server presented during downloadCAChain may
  // differ from the one the user saw in the banner (narrow window — the
  // seconds between the initial probe and the TOFU handshake). Catch the
  // rotation so an attacker can't flip the anchor under the user's feet.
  const expFp = expected?.fingerprint ?? null
  const gotFp = cert?.fingerprint ?? null
  if (expFp && gotFp && expFp !== gotFp) {
    const diff = [
      '⚠⚠ Сертификат сервера ИЗМЕНИЛСЯ между показом баннера и скачиванием',
      '',
      'В баннере был:',
      `  ${expected?.subject ?? '?'} / отпечаток ${expFp}`,
      '',
      'Скачан:',
      `  ${cert?.subject ?? '?'} / отпечаток ${gotFp}`,
      '',
      'Либо плановая ротация сервером в момент setup, либо active MITM.',
      'Сверь новый отпечаток с админом по отдельному каналу перед принятием.',
    ].join('\n')
    if (prompter) {
      await prompter.note(diff, 'Обнаружена ротация cert')
      const confirmed = await prompter.confirm({
        message: 'Всё равно закрепить только что скачанный cert?',
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
}): Promise<{ nextCaPath: string; nextCaBytes: ValidatedCaBytes }> {
  const { prompter, host, port, existingCaPath, currentCert } = args

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
      const banner = buildConfigMissingBanner(
        resolved,
        readErr?.code === 'ENOENT' ? 'файл отсутствует' : `ошибка чтения: ${readErr?.message ?? 'unknown'}`,
        currentCert ?? null,
      )
      await prompter.note(banner.body, banner.title)
      const choice = await prompter.select<string>({
        message: 'Что делать?',
        options: [
          { value: 'abort',    label: 'Отменить и разобраться (безопасно)' },
          { value: 're-tofu',  label: 'Скачать цепочку заново (re-TOFU)' },
          { value: 'use-file', label: 'Указать новый путь к файлу' },
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
        })
      }
      return await readCaFileInteractive({ prompter, host, port })
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
    const banner = buildMismatchBanner(storedCert, currentCert ?? null, resolved, v.error)
    await prompter.note(banner.body, banner.title)
    const choice = await prompter.select<string>({
      message: 'Что делать?',
      options: [
        { value: 'abort',      label: 'Отменить и разобраться (безопасно)' },
        { value: 'accept-new', label: 'Принять новый сертификат и перезаписать цепочку' },
        { value: 'use-file',   label: 'Использовать файл от админа — укажу путь' },
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
      })
    }
    return await readCaFileInteractive({ prompter, host, port })
  }

  // Fresh TOFU
  if (!currentCert) {
    throw new Error(`Untrusted TLS on ${host} but server returned no certificate — cannot prompt for TOFU`)
  }
  const banner = buildFreshTofuBanner(currentCert)
  await prompter.note(banner.body, banner.title)
  const choice = await prompter.select<string>({
    message: 'Что делать?',
    options: [
      { value: 'accept',   label: 'Принять и сохранить цепочку в ~/.openclaw/trueconf-ca.pem' },
      { value: 'use-file', label: 'У меня есть файл сертификата от админа — укажу путь' },
      { value: 'abort',    label: 'Отменить настройку' },
    ],
  })
  if (choice === 'abort') {
    throw new Error(`User aborted: untrusted cert on ${host}`)
  }
  if (choice === 'accept') {
    return await downloadAndAudit({
      host,
      port,
      mode: 'fresh-tofu',
      expected: currentCert,
      prompter,
    })
  }
  return await readCaFileInteractive({ prompter, host, port })
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
  const tc =
    (cfg as { channels?: { trueconf?: {
      serverUrl?: string
      username?: string
      password?: string | { useEnv: string }
      useTls?: boolean
      port?: number
      caPath?: string
    } } }).channels?.trueconf ?? {}

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

  // STEP 1 — explicit env override takes precedence over probe + stored CA.
  // Rationale: operators bootstrapping via CI / Ansible / Kubernetes need a
  // deterministic trust path that doesn't depend on any UI interaction, and
  // that wins over whatever is currently on disk.
  const envPath = process.env.TRUECONF_CA_PATH?.trim()
  if (envPath) {
    const loaded = await loadAndValidateEnvCa({ envPath, host: serverUrl, port: port ?? 443 })
    useTls = true
    port = port ?? 443
    caPath = loaded.abs
    caBytes = loaded.caBytes
  } else if (useTls !== false) {
    // STEP 2 — probe every run. A fresh probe is what makes re-validation work:
    // on re-setup with a stored caPath, `probe.caUntrusted` fires when the
    // server cert has rotated or been MITM'd, routing us into the mismatch
    // branch in handleUntrustedCert. First-setup path uses the same probe.
    await prompter.note('Определяю TLS/порт...', 'Проверка сервера')
    const probe = await probeTls({ host: serverUrl, port })
    if (!probe.reachable) {
      await prompter.note(
        `Probe не смог определить TLS/порт (${probe.error ?? 'unknown'}).\nПробую HTTPS на порту 443 — если не сработает, OAuth вернёт точную причину.`,
        'Probe пропущен',
      )
      useTls = true
      port = port ?? 443
    } else {
      useTls = probe.useTls
      port = port ?? probe.port
      if (probe.caUntrusted && useTls) {
        // STEP 3 — branch into the TOFU UX only when the probe actually saw
        // an untrusted cert. A trusted cert means system-CAs already cover it,
        // so we skip pinning entirely and fall through to OAuth.
        const { nextCaPath, nextCaBytes } = await handleUntrustedCert({
          prompter,
          host: serverUrl,
          port: port!,
          existingCaPath: tc.caPath,
          currentCert: probe.cert,
        })
        caPath = nextCaPath
        caBytes = nextCaBytes
      }
    }
  }

  // OAuth validation loop. Invariant: the CA bytes handed to
  // validateOAuthCredentials are the ones we just validated in-process;
  // never re-read from disk between validate and use.
  let currentPassword = password
  let validated = false
  for (let attempt = 0; attempt < 3 && !validated; attempt++) {
    const result = await validateOAuthCredentials({
      serverUrl,
      username,
      password: currentPassword,
      useTls,
      port,
      ca: caBytes,
    })
    if (result.ok) {
      validated = true
      break
    }

    if (result.category === 'invalid-credentials' && attempt < 2) {
      await prompter.note(`Неверный пароль (${attempt + 1}/3)`, 'OAuth')
      currentPassword = String(await prompter.text({
        message: 'Введите пароль ещё раз',
      }))
      continue
    }

    await prompter.note(`OAuth error: ${result.error}`, 'Ошибка')
    throw new Error(`OAuth failed (user="${username}", server="${serverUrl}"): ${result.category}: ${result.error}`)
  }

  const nextCfg = patchTopLevelChannelConfigSection({
    cfg,
    channel,
    enabled: true,
    patch: {
      ...(useTls !== undefined && { useTls }),
      ...(port !== undefined && { port }),
      password: currentPassword,
      // Clear pinned caPath when TLS is explicitly off — a stale path would
      // otherwise be read by loadCaFromAccount at runtime and handed to a
      // ws:// socket that never uses it.
      caPath: useTls === false ? undefined : caPath,
    },
  })

  await prompter.note(`Подключено как ${username}`, 'TrueConf ready')
  return { cfg: nextCfg }
}

// Env-driven headless finalize. Reads TRUECONF_SERVER_URL/USERNAME/PASSWORD
// (and optional TRUECONF_USE_TLS/PORT), probes TLS when not pinned, validates
// OAuth once (no retry — fail fast in CI/bootstrap contexts), and returns a
// patched cfg with channels.trueconf filled in. Exported for integration tests.
export async function runHeadlessFinalize(cfg: OpenClawConfig): Promise<OpenClawConfig> {
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

  const envCaPath = process.env.TRUECONF_CA_PATH?.trim()

  // 1) Explicit env override takes precedence
  if (envCaPath) {
    const loaded = await loadAndValidateEnvCa({
      envPath: envCaPath,
      host: serverUrl,
      port: resolvedPort ?? 443,
    })
    resolvedUseTls = true
    resolvedPort = resolvedPort ?? 443
    caPath = loaded.abs
    caBytes = loaded.caBytes
  } else {
    // 2) Check configured caPath in current cfg
    const tc = (cfg as { channels?: { trueconf?: { caPath?: string } } }).channels?.trueconf
    const existing = tc?.caPath

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
    ca: caBytes,
  })
  if (!result.ok) {
    throw new Error(`OAuth failed (user="${username}", server="${serverUrl}"): ${result.category}: ${result.error}`)
  }

  return patchTopLevelChannelConfigSection({
    cfg,
    channel,
    enabled: true,
    patch: {
      serverUrl,
      username,
      password,
      ...(resolvedUseTls !== undefined && { useTls: resolvedUseTls }),
      ...(resolvedPort !== undefined && { port: resolvedPort }),
      caPath: resolvedUseTls === false ? undefined : caPath,
    },
  })
}
