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
import { fileURLToPath, pathToFileURL } from 'node:url'
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
      `Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ required, you have ${process.versions.node}. Upgrade: https://nodejs.org/`,
    )
  }
}

async function loadFinalizers() {
  const mod = await jiti.import(join(REPO_ROOT, 'src/channel-setup.ts'))
  return {
    buildSetupWizardDescriptor: mod.buildSetupWizardDescriptor,
    interactiveFinalize: mod.interactiveFinalize,
    runHeadlessFinalize: mod.runHeadlessFinalize,
  }
}

async function loadI18n() {
  const mod = await jiti.import(join(REPO_ROOT, 'src/i18n.ts'))
  return { t: mod.t }
}

// Read TRUECONF_SETUP_LOCALE env. Returns null when unset, throws on invalid
// values so misconfigured CI/Ansible bootstrap fails loud instead of silently
// falling back to a default. Split from cfg-read so the bin can decide
// whether to surface a language prompt before trusting cfg state.
function readEnvLocale() {
  const raw = process.env.TRUECONF_SETUP_LOCALE
  if (raw === 'en' || raw === 'ru') return raw
  if (raw !== undefined) {
    throw new Error(`TRUECONF_SETUP_LOCALE must be 'en' or 'ru', got: ${raw}`)
  }
  return null
}

function readCfgLocale(cfg) {
  const v = cfg?.channels?.trueconf?.setupLocale
  return v === 'en' || v === 'ru' ? v : null
}

// Interactive language picker. Called only when neither env nor cfg pinned a
// locale — gives the operator the choice that the wizard otherwise locks
// silently to en. Labels stay locale-neutral ('English' / 'Russian') so the
// picker reads the same in both languages (see i18n.ts language.option.*).
async function promptLanguage(prompter, t) {
  const picked = await prompter.select({
    message: t('language.prompt', 'en'),
    options: [
      { value: 'en', label: t('language.option.en', 'en') },
      { value: 'ru', label: t('language.option.ru', 'en') },
    ],
  })
  return picked === 'ru' ? 'ru' : 'en'
}

async function loadProbe() {
  // pathToFileURL is required on Windows: ESM dynamic import rejects raw
  // drive-letter paths like `C:\...\probe.mjs` with ERR_UNSUPPORTED_ESM_URL_SCHEME.
  // POSIX paths happen to work either way, so the conversion is universal.
  const mod = await import(pathToFileURL(join(REPO_ROOT, 'src/probe.mjs')).href)
  return {
    probeTls: mod.probeTls,
    downloadCAChain: mod.downloadCAChain,
    parseCertFromPem: mod.parseCertFromPem,
    validateCaAgainstServer: mod.validateCaAgainstServer,
    validateOAuthCredentials: mod.validateOAuthCredentials,
  }
}

async function loadClackPrompter(t, locale) {
  // Direct @clack/prompts usage avoids coupling to the openclaw SDK's
  // setup-runtime re-export, which isn't guaranteed across our peerDep range.
  const clack = await import('@clack/prompts')
  const unwrap = (v) => (typeof v === 'symbol' ? null : v)
  const cancelMsg = t('bin.cancel', locale)
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
      if (clack.isCancel(r)) { clack.cancel(cancelMsg); process.exit(1) }
      return unwrap(r) ?? ''
    },
    password: async (opts) => {
      const r = await clack.password({ message: opts.message, validate: opts.validate })
      if (clack.isCancel(r)) { clack.cancel(cancelMsg); process.exit(1) }
      return unwrap(r) ?? ''
    },
    confirm: async (opts) => {
      const r = await clack.confirm({ message: opts.message, initialValue: opts.initialValue })
      if (clack.isCancel(r)) { clack.cancel(cancelMsg); process.exit(1) }
      return Boolean(r)
    },
    select: async (opts) => {
      const r = await clack.select({ message: opts.message, options: opts.options })
      if (clack.isCancel(r)) { clack.cancel(cancelMsg); process.exit(1) }
      return r
    },
    multiselect: async (opts) => {
      const r = await clack.multiselect({ message: opts.message, options: opts.options, required: false })
      if (clack.isCancel(r)) { clack.cancel(cancelMsg); process.exit(1) }
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

// Auto-registers pluginHostDir in cfg.plugins.load.paths. Stale entries that
// fail realpathSync (ENOENT) are treated as non-matching, not as no-ops —
// otherwise a deleted-but-not-cleaned-up path would silently block the
// re-registration. Skipped when plugins.installs.trueconf is set (npm-install
// path already wires discovery).
export function registerLoadPathIfMissing(cfg, pluginHostDir) {
  if (cfg.plugins?.installs?.trueconf !== undefined) return { cfg, changed: false }

  const targetReal = realpathSync(pluginHostDir)
  const existingPaths = cfg.plugins?.load?.paths ?? []
  const alreadyRegistered = existingPaths.some((entry) => {
    try { return realpathSync(entry) === targetReal } catch { return false }
  })
  if (alreadyRegistered) return { cfg, changed: false }

  return {
    cfg: {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        load: { ...cfg.plugins?.load, paths: [...existingPaths, targetReal] },
      },
    },
    changed: true,
  }
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

// Wizard prompt helpers (promptInteractiveInputs / promptPassword /
// promptProbePreview / patchChannelWithFinalValues / runWizardAndFinalize)
// live in src/setup-shared.ts so the standalone bin AND the SDK setup
// adapter's onboard inline-wizard share the same single source of truth.
async function loadSetupShared() {
  const mod = await jiti.import(join(REPO_ROOT, 'src/setup-shared.ts'))
  return { runWizardAndFinalize: mod.runWizardAndFinalize }
}

function showFinalBanner(prompter, { backupPath, caPath, wizard, t, locale }) {
  const lines = []
  if (backupPath) lines.push(t('bin.completion.backupSaved', locale, { path: backupPath }))
  lines.push('', t('bin.completion.next', locale))
  lines.push(t('bin.completion.step1', locale))
  lines.push(t('bin.completion.step2', locale))
  if (caPath) {
    lines.push(t('bin.completion.gatewayCa', locale))
    lines.push(t('bin.completion.gatewayLegacy', locale))
    lines.push(`       NODE_EXTRA_CA_CERTS=${caPath} openclaw gateway`)
  } else {
    lines.push('       openclaw gateway')
  }
  lines.push('', t('bin.completion.expectedLogs', locale))
  lines.push('  [trueconf] Starting 1 account(s)')
  lines.push('  [trueconf] Connected and authenticated')
  return prompter.note(lines.join('\n'), wizard.completionNote?.title ?? t('bin.completion.title', locale))
}

export async function runSetup({ configPath: configPathArg, prompter: injectedPrompter, probeModule: injectedProbe } = {}) {
  checkNodeVersion()

  const configPath = configPathArg ?? join(homedir(), '.openclaw', 'openclaw.json')
  const cfg = readJsonConfig(configPath)
  const { buildSetupWizardDescriptor, runHeadlessFinalize } = await loadFinalizers()

  // Fail-fast on invalid TRUECONF_SETUP_LOCALE before any backup/probe/OAuth
  // work. cfg-read is separate so we can decide between honoring stored locale
  // and surfacing a language prompt for fresh installs.
  const envLocale = readEnvLocale()
  const cfgLocale = readCfgLocale(cfg)
  const { t } = await loadI18n()

  if (hasEnvShortcut()) {
    // Headless path bypasses the wizard entirely. Locale only matters for
    // any error throwsa runHeadlessFinalize emits; default 'en' is fine.
    const nextCfg = await runHeadlessFinalize(cfg)
    const { cfg: cleaned } = cleanupStaleEntries(nextCfg)
    const { cfg: withLoadPath, changed: loadPathChanged } = registerLoadPathIfMissing(cleaned, REPO_ROOT)
    if (loadPathChanged) console.info(`[trueconf-setup] Registered plugin host at ${realpathSync(REPO_ROOT)}`)
    // Backup only after finalize succeeds — otherwise repeated CI failures
    // accumulate orphan .bak.* files in ~/.openclaw/.
    const { backupPath, error: backupErr } = backupConfigIfExists(configPath)
    if (backupErr) {
      process.stderr.write(`[trueconf-setup] warning: backup failed (${backupErr.message}); proceeding without it\n`)
    }
    writeJsonConfigAtomic(configPath, withLoadPath)
    return { backupPath, mode: 'headless' }
  }

  // Prompter must exist before the language prompt; it's also the cancel-msg
  // owner, so the locale passed here only colors that one banner. Subsequent
  // prompts honor the resolved `locale` below.
  const initialLocale = envLocale ?? cfgLocale ?? 'en'
  const prompter = injectedPrompter ?? (await loadClackPrompter(t, initialLocale))

  // Show language prompt only when neither env nor cfg pinned a locale.
  // UAT scenarios E2/E3 (env or cfg locale set) → no prompt; A1/E1 (fresh
  // install, nothing set) → prompt.
  let locale
  if (envLocale) locale = envLocale
  else if (cfgLocale) locale = cfgLocale
  else locale = await promptLanguage(prompter, t)

  // Build the wizard descriptor with the now-final locale so all operator-
  // facing strings (intro, validate messages, credential prompts, completion)
  // render in the user's chosen language.
  const wizard = buildSetupWizardDescriptor(t, locale)

  if (hasExistingTrueconfChannel(cfg)) {
    const overwrite = await prompter.confirm({
      message: t('bin.overwrite.confirm', locale),
      initialValue: false,
    })
    if (!overwrite) {
      await prompter.note(
        t('bin.overwrite.untouched', locale),
        t('bin.cancel', locale),
      )
      return { mode: 'cancelled-overwrite' }
    }
  }

  if (wizard.introNote) {
    await prompter.note(
      wizard.introNote.lines.join('\n'),
      wizard.introNote.title,
    )
  }

  const probeModule = injectedProbe ?? (await loadProbe())
  const { runWizardAndFinalize } = await loadSetupShared()
  const { cfg: finalCfg, savedWithoutValidation, caPath } = await runWizardAndFinalize({
    cfg, prompter, wizard, probeModule, locale, t,
  })
  // username pulled from finalCfg for the post-write `connected` banner;
  // runWizardAndFinalize already validated serverUrl/username/password
  // invariants before patching.
  const username = finalCfg.channels?.trueconf?.username ?? ''

  const { cfg: cleanedFinal, cleaned } = cleanupStaleEntries(finalCfg)
  const { cfg: withLoadPath, changed: loadPathChanged } = registerLoadPathIfMissing(cleanedFinal, REPO_ROOT)
  if (loadPathChanged) console.info(`[trueconf-setup] Registered plugin host at ${realpathSync(REPO_ROOT)}`)
  const { backupPath, error: backupErr } = backupConfigIfExists(configPath)
  if (backupErr) {
    await prompter.note(
      t('bin.backupFailed', locale, { message: backupErr.message }),
      'Backup warning',
    )
  }
  writeJsonConfigAtomic(configPath, withLoadPath)

  if (cleaned) {
    await prompter.note(t('bin.cleanup.removed', locale), t('bin.cleanup.title', locale))
  }
  if (savedWithoutValidation) {
    await prompter.note(
      t('bin.savedNoOauth.body', locale),
      t('bin.savedNoOauth.title', locale),
    )
  } else {
    await prompter.note(t('connected.body', locale, { username }), t('connected.title', locale))
  }

  await showFinalBanner(prompter, { backupPath, caPath, wizard, t, locale })

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
    // Letting the loop drain naturally instead of calling process.exit(0)
    // dodges nodejs/node#56645 — on Windows + Node 23+/24.x, an abrupt
    // process.exit() after a fetch() races libuv's handle teardown and
    // crashes with `assertion failed !(handle->flags & UV_HANDLE_CLOSING)`
    // in src/win/async.c. Setting exitCode preserves the shell-status
    // contract; the validateOAuthCredentials dispatcher cleanup keeps the
    // pending-handle set empty so the process exits within milliseconds.
    process.exitCode = 0
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`trueconf-setup failed: ${detail}\n`)
    process.exitCode = 1
  }
  // Watchdog: if some future regression leaks an event-loop handle (clack
  // stdin in raw mode, a sharp libvips worker, an unref-missed timer), the
  // wizard would otherwise look successful and then freeze the terminal
  // forever. .unref() so the timer never keeps the loop alive itself —
  // it fires only when the loop is hung past 10s.
  setTimeout(() => {
    process.stderr.write(
      'trueconf-setup: finished but the event loop is still busy after 10s — ' +
      'a leaked handle is keeping the process alive. Please report with OS and ' +
      'Node version. Forcing exit now.\n',
    )
    process.exit(process.exitCode ?? 0)
  }, 10_000).unref()
}
