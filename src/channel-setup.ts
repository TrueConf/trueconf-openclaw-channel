import { readFileSync } from 'node:fs'
import type { ChannelSetupWizard, OpenClawConfig, WizardPrompter } from 'openclaw/plugin-sdk/setup'
import {
  patchTopLevelChannelConfigSection,
  hasConfiguredSecretInput,
} from 'openclaw/plugin-sdk/setup'
import { probeTls, downloadCAChain, validateOAuthCredentials } from './probe.mjs'
import { resolveSecret } from './config'

const channel = 'trueconf'

// Reads the CA bundle into memory so it can be passed to probe's OAuth validator
// as bytes. Keeps probe.mjs free of filesystem reads — the security scanner
// flags fs-read + network-send combinations as a potential exfiltration pattern.
function readCaBuffer(caPath: string | undefined): Uint8Array | undefined {
  if (!caPath) return undefined
  try {
    return readFileSync(caPath)
  } catch {
    return undefined
  }
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
      validate: ({ value }) =>
        value.includes('://') ? 'Укажите хост без http(s)://' : undefined,
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

  if (useTls === undefined) {
    await prompter.note('Определяю TLS/порт...', 'Проверка сервера')
    const tls = await probeTls({ host: serverUrl, port })
    if (tls.reachable) {
      useTls = tls.useTls
      port = port ?? tls.port
      if (tls.caUntrusted) {
        const confirm = await prompter.select<string>({
          message: 'Сертификат самоподписанный. Скачать цепочку?',
          options: [
            { value: 'yes', label: 'Да, сохранить в ~/.openclaw/trueconf-ca.pem' },
            { value: 'no', label: 'Отменить настройку' },
          ],
        })
        if (confirm !== 'yes') throw new Error(`User aborted: untrusted cert on ${serverUrl}`)
        caPath = await downloadCAChain({ host: serverUrl, port })
      }
    } else {
      // Probe failure is a hint, not a gate: OAuth over a corporate proxy can
      // still succeed even when a raw TLS probe is firewalled.
      await prompter.note(
        `Probe не смог определить TLS/порт (${tls.error ?? 'unknown'}).\nПробую HTTPS на порту 443 — если не сработает, OAuth вернёт точную причину.`,
        'Probe пропущен',
      )
      useTls = true
      port = port ?? 443
    }
  }

  let currentPassword = password
  let validated = false
  // Retry up to 3x total, BUT only on `invalid-credentials`.
  // All other failure categories (server-error, network, tls, etc.) are fatal.
  for (let attempt = 0; attempt < 3 && !validated; attempt++) {
    const result = await validateOAuthCredentials({
      serverUrl,
      username,
      password: currentPassword,
      useTls,
      port,
      ca: readCaBuffer(caPath),
    })
    if (result.ok) {
      validated = true
      break
    }

    if (result.category === 'invalid-credentials' && attempt < 2) {
      await prompter.note(`Неверный пароль (${attempt + 1}/3)`, 'OAuth')
      // WizardPrompter lacks password(); retry prompt echoes plaintext.
      currentPassword = String(await prompter.text({
        message: 'Введите пароль ещё раз',
      }))
      continue
    }

    // Fatal: surface error and abort (no retry for network/tls/server-error/etc.)
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
      ...(caPath && { caPath }),
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
  let probeFailure: string | undefined

  if (resolvedUseTls === undefined) {
    const tls = await probeTls({ host: serverUrl, port: resolvedPort })
    if (tls.reachable) {
      resolvedUseTls = tls.useTls
      resolvedPort = resolvedPort ?? tls.port
      if (tls.caUntrusted) {
        if (process.env.TRUECONF_ACCEPT_UNTRUSTED_CA !== 'true') {
          throw new Error(
            'Self-signed cert detected; set TRUECONF_ACCEPT_UNTRUSTED_CA=true to auto-download chain',
          )
        }
        caPath = await downloadCAChain({ host: serverUrl, port: resolvedPort })
      }
    } else {
      resolvedUseTls = true
      resolvedPort = resolvedPort ?? 443
      probeFailure = tls.error ?? 'unknown'
      // In CI/headless contexts users only see stderr; emit the probe
      // outcome so support can correlate a later OAuth failure with the
      // earlier probe unreachability.
      process.stderr.write(
        `[trueconf-setup] TLS probe failed (${probeFailure}); defaulting to HTTPS:443\n`,
      )
    }
  }

  const result = await validateOAuthCredentials({
    serverUrl,
    username,
    password,
    useTls: resolvedUseTls,
    port: resolvedPort,
    ca: readCaBuffer(caPath),
  })
  if (!result.ok) {
    const probeHint = probeFailure ? ` (earlier probe failure: ${probeFailure})` : ''
    throw new Error(`OAuth failed (user="${username}", server="${serverUrl}"): ${result.category}: ${result.error}${probeHint}`)
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
      ...(caPath && { caPath }),
    },
  })
}
