#!/usr/bin/env node
// Standalone setup CLI for the TrueConf channel plugin.
//
// Exists because openclaw's CLI has no public entry point that invokes a
// third-party plugin's setupEntry wizard: `channels add --channel` has a
// hardcoded whitelist, `plugins install` doesn't run wizards. Until upstream
// ships plugin wizard discovery, we surface the wizard here and write the
// resulting creds to ~/.openclaw/openclaw.json directly.

import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync, mkdirSync, copyFileSync, unlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
// fsCache:false — transpiled-TS cache persists stale channel-setup.ts across
// edits in dev, masking wizard changes.
const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false, moduleCache: false })

const MIN_NODE_MAJOR = 22
const MIN_NODE_MINOR = 14

function checkNodeVersion() {
  const [maj, min] = process.versions.node.split('.').map((n) => Number.parseInt(n, 10))
  if (!Number.isFinite(maj) || maj < MIN_NODE_MAJOR || (maj === MIN_NODE_MAJOR && min < MIN_NODE_MINOR)) {
    throw new Error(
      `Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ требуется, у вас ${process.versions.node}. Обновитесь: https://nodejs.org/`,
    )
  }
}

async function loadFinalizers() {
  const mod = await jiti.import(join(REPO_ROOT, 'src/channel-setup.ts'))
  return {
    trueconfSetupWizard: mod.trueconfSetupWizard,
    interactiveFinalize: mod.interactiveFinalize,
    runHeadlessFinalize: mod.runHeadlessFinalize,
  }
}

async function loadI18n() {
  const mod = await jiti.import(join(REPO_ROOT, 'src/i18n.ts'))
  return { t: mod.t }
}

// Resolve setup locale for bin's standalone path. Mirrors precedence used by
// src/channel-setup.ts: env > cfg.channels.trueconf.setupLocale > 'en'.
// Throws on an invalid env value to fail loud in CI/Ansible bootstrap.
function resolveBinLocale(cfg) {
  const raw = process.env.TRUECONF_SETUP_LOCALE
  if (raw === 'en' || raw === 'ru') return raw
  if (raw !== undefined) {
    throw new Error(`TRUECONF_SETUP_LOCALE must be 'en' or 'ru', got: ${raw}`)
  }
  const cfgLocale = cfg?.channels?.trueconf?.setupLocale
  if (cfgLocale === 'en' || cfgLocale === 'ru') return cfgLocale
  return 'en'
}

async function loadProbe() {
  const mod = await import(join(REPO_ROOT, 'src/probe.mjs'))
  return {
    probeTls: mod.probeTls,
    downloadCAChain: mod.downloadCAChain,
  }
}

async function loadClackPrompter() {
  // Direct @clack/prompts usage avoids coupling to the openclaw SDK's
  // setup-runtime re-export, which isn't guaranteed across our peerDep range.
  const clack = await import('@clack/prompts')
  const unwrap = (v) => (typeof v === 'symbol' ? null : v)
  return {
    intro: async (msg) => clack.intro(msg),
    outro: async (msg) => clack.outro(msg),
    note: async (msg, title) => clack.note(msg, title),
    text: async (opts) => {
      const r = await clack.text({
        message: opts.message,
        placeholder: opts.placeholder,
        initialValue: opts.initialValue,
        validate: opts.validate,
      })
      if (clack.isCancel(r)) { clack.cancel('Отменено'); process.exit(1) }
      return unwrap(r) ?? ''
    },
    password: async (opts) => {
      const r = await clack.password({ message: opts.message, validate: opts.validate })
      if (clack.isCancel(r)) { clack.cancel('Отменено'); process.exit(1) }
      return unwrap(r) ?? ''
    },
    confirm: async (opts) => {
      const r = await clack.confirm({ message: opts.message, initialValue: opts.initialValue })
      if (clack.isCancel(r)) { clack.cancel('Отменено'); process.exit(1) }
      return Boolean(r)
    },
    select: async (opts) => {
      const r = await clack.select({ message: opts.message, options: opts.options })
      if (clack.isCancel(r)) { clack.cancel('Отменено'); process.exit(1) }
      return r
    },
    multiselect: async (opts) => {
      const r = await clack.multiselect({ message: opts.message, options: opts.options, required: false })
      if (clack.isCancel(r)) { clack.cancel('Отменено'); process.exit(1) }
      return Array.isArray(r) ? r : []
    },
    progress: (opts) => {
      const s = clack.spinner()
      s.start(opts?.message ?? '')
      return { update: (msg) => s.message(msg ?? ''), stop: (msg) => s.stop(msg ?? '') }
    },
  }
}

function readJsonConfig(configPath) {
  if (!existsSync(configPath)) return {}
  const raw = readFileSync(configPath, 'utf8')
  return raw.trim() === '' ? {} : JSON.parse(raw)
}

// Reads the CA bundle into memory so probe.mjs can receive it as bytes.
// Keeps probe.mjs free of filesystem reads for the security scanner.
//
// Throws loud on read failure: silently swallowing ENOENT here would
// downgrade the operator's pinned-CA trust mode to system trust without
// any indication, violating the "no silent fallbacks on readFileSync(caPath)"
// invariant in AGENTS.md. Caller is responsible for handing tlsVerify=false
// paths a `caPath` of undefined so this never fires for insecure mode.
function readCaBuffer(caPath) {
  if (!caPath) return undefined
  try {
    return readFileSync(caPath)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`CA file unreadable: ${caPath} (${reason})`)
  }
}

function backupConfigIfExists(configPath) {
  if (!existsSync(configPath)) return { backupPath: null }
  const backupPath = `${configPath}.bak.${Date.now()}`
  try {
    copyFileSync(configPath, backupPath)
    return { backupPath }
  } catch (err) {
    return { backupPath: null, error: err }
  }
}

function cleanupStaleEntries(cfg) {
  // plugins.entries.trueconf is legacy; discovery now uses plugins.installs +
  // plugins.load.paths. A stale entry here confuses the loader.
  if (cfg.plugins?.entries?.trueconf) {
    const next = { ...cfg, plugins: { ...cfg.plugins, entries: { ...cfg.plugins.entries } } }
    delete next.plugins.entries.trueconf
    return { cfg: next, cleaned: true }
  }
  return { cfg, cleaned: false }
}

function writeJsonConfigAtomic(configPath, cfg) {
  mkdirSync(dirname(configPath), { recursive: true })
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`
  const serialized = JSON.stringify(cfg, null, 2) + '\n'
  let renamed = false
  try {
    writeFileSync(tmpPath, serialized, { encoding: 'utf8' })
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, configPath)
    renamed = true
  } finally {
    if (!renamed) {
      try { unlinkSync(tmpPath) } catch { /* tmp may not exist if writeFileSync threw first */ }
    }
  }
}

function hasEnvShortcut() {
  return Boolean(
    process.env.TRUECONF_SERVER_URL?.trim() &&
      process.env.TRUECONF_USERNAME?.trim() &&
      process.env.TRUECONF_PASSWORD?.trim(),
  )
}

function hasExistingTrueconfChannel(cfg) {
  return Boolean(cfg.channels?.trueconf)
}

async function promptInteractiveInputs(prompter, wizard, currentCfg) {
  // Optional inputs with no existing value are skipped; probe step owns TLS/port.
  let cfg = currentCfg
  for (const input of wizard.textInputs) {
    const current = input.currentValue ? input.currentValue({ cfg, accountId: 'default' }) : undefined
    if (!input.required && (current === undefined || current === '')) continue

    const placeholder = input.placeholder ?? (current ?? '')
    const raw = await prompter.text({
      message: input.message,
      placeholder,
      initialValue: current,
    })
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '' && !input.applyEmptyValue && current !== undefined) continue
    if (value === '' && input.required) throw new Error(`Поле обязательно: ${input.message}`)
    if (input.validate) {
      const err = input.validate({ value, cfg, accountId: 'default' })
      if (err) throw new Error(`${input.message}: ${err}`)
    }
    const normalized = input.normalizeValue
      ? input.normalizeValue({ value, cfg, accountId: 'default' })
      : value
    cfg = input.applySet({ cfg, value: normalized, accountId: 'default' })
  }
  return cfg
}

async function promptPassword(prompter, wizard, cfg) {
  const credential = wizard.credentials[0]
  const state = credential.inspect({ cfg, accountId: 'default' })
  const allowEnv = credential.allowEnv?.({ cfg, accountId: 'default' }) ?? false

  if (allowEnv && state.envValue) {
    const useEnv = await prompter.confirm({
      message: credential.envPrompt ?? `Использовать ${credential.preferredEnvVar} из окружения?`,
      initialValue: true,
    })
    if (useEnv) {
      const nextCfg = await credential.applyUseEnv({ cfg, accountId: 'default' })
      return { cfg: nextCfg, credentialValues: { [credential.inputKey]: state.envValue } }
    }
  }

  if (state.hasConfiguredValue) {
    const keep = await prompter.confirm({
      message: credential.keepPrompt ?? 'Пароль уже задан. Оставить?',
      initialValue: true,
    })
    if (keep) return { cfg, credentialValues: {} }
  }

  const pwd = await prompter.password({ message: credential.inputPrompt ?? 'Введите пароль' })
  if (typeof pwd !== 'string' || pwd === '') throw new Error('Пароль не может быть пустым')
  const nextCfg = credential.applySet({ cfg, value: pwd, accountId: 'default' })
  return { cfg: nextCfg, credentialValues: { [credential.inputKey]: pwd } }
}

async function promptProbePreview(prompter, probeModule, serverUrl, currentUseTls, currentPort, t, locale) {
  // If user has pinned useTls or port in cfg, skip probe and respect choice.
  if (currentUseTls !== undefined && currentPort !== undefined) {
    return { useTls: currentUseTls, port: currentPort, caPath: undefined, tlsVerify: undefined }
  }

  await prompter.note('Определяю TLS/порт...', 'Проверка сервера')
  const probe = await probeModule.probeTls({ host: serverUrl, port: currentPort })

  let useTls, port, caPath, tlsVerify, reason
  if (probe.reachable) {
    useTls = currentUseTls ?? probe.useTls
    port = currentPort ?? probe.port
    if (probe.caUntrusted && useTls) {
      const confirmCa = await prompter.confirm({
        message: 'Сертификат самоподписанный или от корпоративного CA. Скачать цепочку в ~/.openclaw/trueconf-ca.pem?',
        initialValue: true,
      })
      if (confirmCa) {
        caPath = (await probeModule.downloadCAChain({ host: serverUrl, port })).path
      } else {
        // Escape hatch: declining download routes to the per-TrueConf insecure
        // mode. Show the spec-mandated MITM warning and require an explicit
        // second confirm, defaulting to false so a thoughtless Enter doesn't
        // disable verification. Reused i18n keys keep copy in lockstep with
        // the SDK wizard's insecure path.
        const goInsecure = await prompter.confirm({
          message: `${t('tls.insecure.warning', locale)}\n\n${t('tls.insecure.confirm', locale)}`,
          initialValue: false,
        })
        if (!goInsecure) throw new Error(`User aborted: untrusted cert on ${serverUrl}`)
        tlsVerify = false
      }
    }
    reason = probe.caUntrusted ? (tlsVerify === false ? 'tls-insecure' : 'tls-untrusted') : (useTls ? 'tls-valid' : 'bridge-open')
  } else {
    // Probe failure is a hint, not a gate: OAuth over a corporate proxy can
    // still succeed even when a raw TLS probe is firewalled.
    await prompter.note(
      `Probe не смог определить TLS/порт: ${probe.error ?? 'unknown'}.\nПо умолчанию пробую HTTPS:443. OAuth вернёт точную причину если не сработает.`,
      'Probe пропущен',
    )
    useTls = currentUseTls ?? true
    port = currentPort ?? 443
    reason = 'fallback'
  }

  // Preview + let user override.
  const scheme = useTls ? 'wss' : 'ws'
  const isDefaultPort = (useTls && port === 443) || (!useTls && port === 80)
  const hostPart = isDefaultPort ? serverUrl : `${serverUrl}:${port}`
  const reasonLabels = {
    'tls-valid': `TLS на ${port}, валидный сертификат`,
    'tls-untrusted': `TLS на ${port}, корпоративный/самоподписанный CA${caPath ? ` (скачан в ${caPath})` : ''}`,
    'tls-insecure': `TLS на ${port}, проверка сертификата отключена (только для TrueConf)`,
    'bridge-open': `без TLS, Bridge на ${port}`,
    'fallback': `probe не ответил, пробую HTTPS:${port}`,
  }
  await prompter.note(
    `${scheme}://${hostPart}/websocket/chat_bot/\n(${reasonLabels[reason] ?? reason})`,
    'Подключусь как',
  )

  const accept = await prompter.confirm({
    message: 'Принять?',
    initialValue: true,
  })
  if (accept) return { useTls, port, caPath, tlsVerify }

  // Manual override branch.
  const manualTls = await prompter.confirm({ message: 'TLS (https/wss)?', initialValue: useTls })
  const manualPortRaw = await prompter.text({
    message: `Порт (пусто = ${manualTls ? 443 : 4309})`,
    placeholder: String(manualTls ? 443 : 4309),
  })
  const manualPortTrimmed = typeof manualPortRaw === 'string' ? manualPortRaw.trim() : ''
  const manualPort = manualPortTrimmed === '' ? (manualTls ? 443 : 4309) : Number.parseInt(manualPortTrimmed, 10)
  if (!Number.isFinite(manualPort) || manualPort < 1 || manualPort > 65535) {
    throw new Error(`Невалидный порт: ${manualPortRaw}`)
  }
  return { useTls: manualTls, port: manualPort, caPath, tlsVerify }
}

function patchChannelWithFinalValues(cfg, { serverUrl, username, password, useTls, port, caPath, tlsVerify, setupLocale }) {
  // Shallow-patch channels.trueconf preserving any existing side-fields
  // (dmPolicy, allowFrom, maxFileSize, etc.) that the user configured manually.
  // Mutually exclusive trust modes: when tlsVerify === false the saved cfg
  // must NOT carry a stale caPath — runtime would otherwise see two
  // contradictory trust signals. We rebuild the spread without caPath in
  // that case rather than relying on the consumer to ignore it.
  const existing = cfg.channels?.trueconf ?? {}
  const { caPath: _existingCaPath, tlsVerify: _existingTlsVerify, ...existingRest } = existing
  const trueconf = {
    ...existingRest,
    enabled: true,
    serverUrl,
    username,
    password,
    useTls,
    port,
    ...(setupLocale && { setupLocale }),
  }
  if (tlsVerify === false) {
    trueconf.tlsVerify = false
  } else if (caPath) {
    trueconf.caPath = caPath
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      trueconf,
    },
  }
}

function showFinalBanner(prompter, { backupPath, caPath, wizard }) {
  const lines = []
  if (backupPath) lines.push(`Предыдущий конфиг сохранён: ${backupPath}`)
  lines.push('', 'Дальше:')
  lines.push('  1. Настроить LLM-провайдера, если ещё не: openclaw configure')
  lines.push('  2. Запустить gateway:')
  if (caPath) {
    lines.push(`       openclaw gateway      (CA уже прописан в конфиг, доп. env не нужен)`)
    lines.push(`       # или на старой openclaw без caPath-поддержки:`)
    lines.push(`       NODE_EXTRA_CA_CERTS=${caPath} openclaw gateway`)
  } else {
    lines.push('       openclaw gateway')
  }
  lines.push('', 'Ожидаемые логи успеха:')
  lines.push('  [trueconf] Starting 1 account(s)')
  lines.push('  [trueconf] Connected and authenticated')
  return prompter.note(lines.join('\n'), wizard.completionNote?.title ?? 'Готово')
}

export async function runSetup({ configPath: configPathArg, prompter: injectedPrompter, probeModule: injectedProbe } = {}) {
  checkNodeVersion()

  const configPath = configPathArg ?? join(homedir(), '.openclaw', 'openclaw.json')
  const cfg = readJsonConfig(configPath)
  const { trueconfSetupWizard, runHeadlessFinalize } = await loadFinalizers()

  // Resolve once so an invalid TRUECONF_SETUP_LOCALE fails fast — before any
  // backup/probe/OAuth work — and so the interactive bin path persists the
  // resolved value into cfg the same way runHeadlessFinalize does.
  const locale = resolveBinLocale(cfg)

  if (hasEnvShortcut()) {
    const nextCfg = await runHeadlessFinalize(cfg)
    const { cfg: cleaned } = cleanupStaleEntries(nextCfg)
    // Backup only after finalize succeeds — otherwise repeated CI failures
    // accumulate orphan .bak.* files in ~/.openclaw/.
    const { backupPath, error: backupErr } = backupConfigIfExists(configPath)
    if (backupErr) {
      process.stderr.write(`[trueconf-setup] warning: backup failed (${backupErr.message}); proceeding without it\n`)
    }
    writeJsonConfigAtomic(configPath, cleaned)
    return { backupPath, mode: 'headless' }
  }

  const prompter = injectedPrompter ?? (await loadClackPrompter())

  if (hasExistingTrueconfChannel(cfg)) {
    const overwrite = await prompter.confirm({
      message: 'В конфиге уже есть channels.trueconf. Перезаписать?',
      initialValue: false,
    })
    if (!overwrite) {
      await prompter.note(
        'Конфиг не тронут. Чтобы запустить без изменений: openclaw gateway',
        'Отменено',
      )
      return { mode: 'cancelled-overwrite' }
    }
  }

  if (trueconfSetupWizard.introNote) {
    await prompter.note(
      trueconfSetupWizard.introNote.lines.join('\n'),
      trueconfSetupWizard.introNote.title,
    )
  }

  const cfgWithInputs = await promptInteractiveInputs(prompter, trueconfSetupWizard, cfg)
  const { cfg: cfgWithPassword, credentialValues } = await promptPassword(
    prompter,
    trueconfSetupWizard,
    cfgWithInputs,
  )

  const tcFields = cfgWithPassword.channels?.trueconf ?? {}
  const serverUrl = tcFields.serverUrl
  const username = tcFields.username
  const password = credentialValues.password ?? tcFields.password
  if (!serverUrl || !username || !password) {
    throw new Error('Invariant: серверU/логин/пароль не собрались к финальной стадии')
  }

  const probeModule = injectedProbe ?? (await loadProbe())
  const { t } = await loadI18n()
  const { useTls, port, caPath, tlsVerify } = await promptProbePreview(
    prompter,
    probeModule,
    serverUrl,
    tcFields.useTls,
    tcFields.port,
    t,
    locale,
  )

  const { validateOAuthCredentials } = injectedProbe ?? (await import(join(REPO_ROOT, 'src/probe.mjs')))
  let oauthOk = false
  let oauthError = null
  let currentPassword = password

  for (let attempt = 0; attempt < 3 && !oauthOk; attempt++) {
    // tlsVerify:false drops the CA bytes — passing both is a contradictory
    // signal to validateOAuthCredentials and the operator already opted out
    // of pinning when they picked insecure mode.
    const result = await validateOAuthCredentials({
      serverUrl, username, password: currentPassword, useTls, port,
      ca: tlsVerify === false ? undefined : readCaBuffer(caPath),
      tlsVerify,
    })
    if (result.ok) { oauthOk = true; break }
    oauthError = result
    if (result.category === 'invalid-credentials' && attempt < 2) {
      await prompter.note(`Неверный пароль (${attempt + 1}/3)`, 'OAuth')
      currentPassword = await prompter.password({ message: 'Введите пароль ещё раз' })
      if (typeof currentPassword !== 'string' || currentPassword === '') {
        throw new Error('Пароль не может быть пустым')
      }
      continue
    }
    break
  }

  let finalCfg
  let savedWithoutValidation = false

  if (oauthOk) {
    finalCfg = patchChannelWithFinalValues(cfgWithPassword, {
      serverUrl, username, password: currentPassword, useTls, port, caPath, tlsVerify, setupLocale: locale,
    })
  } else {
    // Save-without-validation fallback — only for categories other than
    // invalid-credentials (those already retried 3× above).
    const errMsg = `${oauthError.category}: ${oauthError.error}`
    if (oauthError.category === 'invalid-credentials') {
      throw new Error(`OAuth failed (user="${username}", server="${serverUrl}"): ${errMsg}`)
    }
    await prompter.note(
      `OAuth ошибка: ${errMsg}\nСервер мог быть временно недоступен, за прокси, или TLS-конфигурация странная.`,
      'Проверка не прошла',
    )
    // Default=true only for `network` (transient/intermittent). For `tls`
    // and `server-error`, retry at gateway startup will hit the same wall,
    // so default=false and require user to actively opt in.
    const saveAnywayDefault = oauthError.category === 'network'
    const saveAnyway = await prompter.confirm({
      message: 'Сохранить креды как есть? OAuth проверится при `openclaw gateway`',
      initialValue: saveAnywayDefault,
    })
    if (!saveAnyway) {
      throw new Error(`OAuth failed (user="${username}", server="${serverUrl}"): ${errMsg}`)
    }
    finalCfg = patchChannelWithFinalValues(cfgWithPassword, {
      serverUrl, username, password: currentPassword, useTls, port, caPath, tlsVerify, setupLocale: locale,
    })
    savedWithoutValidation = true
  }

  const { cfg: cleanedFinal, cleaned } = cleanupStaleEntries(finalCfg)
  const { backupPath, error: backupErr } = backupConfigIfExists(configPath)
  if (backupErr) {
    await prompter.note(
      `Не смог создать backup (${backupErr.message}). Продолжаем без него.`,
      'Backup warning',
    )
  }
  writeJsonConfigAtomic(configPath, cleanedFinal)

  if (cleaned) {
    await prompter.note('Удалил устаревший plugins.entries.trueconf из конфига', 'Очистка')
  }
  if (savedWithoutValidation) {
    await prompter.note(
      'Конфиг записан без OAuth-валидации. Если при `openclaw gateway` будут ошибки подключения — запусти `npm run setup` ещё раз.',
      'Важно',
    )
  } else {
    await prompter.note(`Подключено как ${username}`, 'TrueConf ready')
  }

  await showFinalBanner(prompter, { backupPath, caPath, wizard: trueconfSetupWizard })

  return { backupPath, caPath, mode: savedWithoutValidation ? 'saved-without-validation' : 'saved' }
}

// CLI entry — only run when invoked directly, not when imported by tests.
// realpathSync resolves .bin/ symlinks created by npm/npx so the check works
// when the user runs `npx -p <pkg> trueconf-setup` (which invokes via symlink).
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
    await runSetup()
    process.exit(0)
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`trueconf-setup failed: ${detail}\n`)
    process.exit(1)
  }
}
