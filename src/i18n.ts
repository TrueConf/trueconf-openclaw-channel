// Translation table for the TrueConf setup wizard (interactive + headless).
// Keys are flat strings; every entry has both `en` and `ru` text. The
// runtime resolution layer is responsible for picking the locale; this
// module just throws on unknown keys so missing copy fails loudly in tests.

export type Locale = 'en' | 'ru'
export const DEFAULT_LOCALE: Locale = 'en'

const TRANSLATIONS = {
  // Language selection
  'language.prompt':                   { en: 'Language / Язык:', ru: 'Язык / Language:' },
  'language.option.en':                { en: 'English (default)', ru: 'Английский (по умолчанию)' },
  'language.option.ru':                { en: 'Russian', ru: 'Русский' },
  'locale.invalidEnv':                 { en: "TRUECONF_SETUP_LOCALE must be 'en' or 'ru', got: {{value}}", ru: "TRUECONF_SETUP_LOCALE должно быть 'en' или 'ru', получено: {{value}}" },

  // TLS untrusted cert flow titles + hints (seeded for Tasks 5/6)
  'tls.untrusted.title':               { en: 'Untrusted TLS certificate', ru: 'Недоверенный TLS-сертификат' },
  'tls.cafile.hint':                   { en: 'Specify the path to a root CA certificate in PEM format.', ru: 'Укажите путь к корневому сертификату CA в PEM-формате.' },
  'tls.cafile.unreadable':             { en: 'Cannot read CA file at {{path}}: {{reason}}', ru: 'Не могу прочитать файл CA по пути {{path}}: {{reason}}' },
  'tls.insecure.warning':              { en: 'The connection to TrueConf will be established without TLS certificate verification. This may enable a MITM attack. Use this mode only in a safe or restricted environment; verification stays on for the rest of Node.js.', ru: 'Соединение с TrueConf будет установлено без проверки TLS-сертификата. Это может позволить MITM-атаку. Используйте этот режим только в безопасной или ограниченной среде; для остального Node.js проверка остаётся включённой.' },
  'tls.insecure.confirm':              { en: 'Disable TLS certificate verification?', ru: 'Отключить проверку TLS-сертификата?' },
  'tls.insecure.invalidEnv':           { en: "TRUECONF_TLS_VERIFY must be 'false' or unset, got: {{value}}", ru: "TRUECONF_TLS_VERIFY должно быть 'false' или не задано, получено: {{value}}" },
  'tls.insecure.conflict':             { en: 'TRUECONF_CA_PATH and TRUECONF_TLS_VERIFY=false are incompatible — pick one trust mode.', ru: 'TRUECONF_CA_PATH и TRUECONF_TLS_VERIFY=false несовместимы — выберите один режим доверия.' },

  // CA file interactive prompt
  'cafile.prompt':                     { en: 'Path to certificate file (PEM):', ru: 'Путь к файлу сертификата (PEM):' },
  'cafile.title':                      { en: 'CA file input', ru: 'CA file input' },
  'cafile.notPem':                     { en: 'File is not PEM. DER/P7B not supported — convert: openssl x509 -in cert.der -inform DER -out cert.pem', ru: 'Файл не PEM. DER/P7B не поддерживаются — конвертируй: openssl x509 -in cert.der -inform DER -out cert.pem' },
  'cafile.unreachable':                { en: 'Cannot reach {{host}}:{{port}} — {{error}}.\nCA file cannot be checked while server is unreachable. Check network/DNS/firewall and retry.', ru: 'Не могу подключиться к {{host}}:{{port}} — {{error}}.\nCA-файл не проверить пока сервер недоступен. Проверь сеть/DNS/firewall и повтори.' },
  'cafile.chainMismatch':              { en: 'File does not validate this server:\n  Trust anchor in file: {{fileIssuer}} (fingerprint {{fileFp}})\n  Server signed by: {{serverIssuer}} (fingerprint {{serverFp}})\n  Possible: wrong file / wrong server / incomplete chain.\n  TLS stack: {{error}}', ru: 'Файл не валидирует этот сервер:\n  Trust anchor в файле: {{fileIssuer}} (отпечаток {{fileFp}})\n  Сервер подписан: {{serverIssuer}} (отпечаток {{serverFp}})\n  Возможно: не тот файл / не тот сервер / chain не полный.\n  TLS-стек: {{error}}' },

  // Cert rotation (TOCTOU)
  'rotation.title':                    { en: 'Cert rotation detected', ru: 'Обнаружена ротация cert' },
  'rotation.body':                     { en: '⚠⚠ Server certificate CHANGED between banner display and download\n\nIn banner:\n  {{expectedSubject}} / fingerprint {{expectedFp}}\n\nDownloaded:\n  {{gotSubject}} / fingerprint {{gotFp}}\n\nEither a planned rotation by the server during setup, or active MITM.\nVerify the new fingerprint with the admin via a separate channel before accepting.', ru: '⚠⚠ Сертификат сервера ИЗМЕНИЛСЯ между показом баннера и скачиванием\n\nВ баннере был:\n  {{expectedSubject}} / отпечаток {{expectedFp}}\n\nСкачан:\n  {{gotSubject}} / отпечаток {{gotFp}}\n\nЛибо плановая ротация сервером в момент setup, либо active MITM.\nСверь новый отпечаток с админом по отдельному каналу перед принятием.' },
  'rotation.confirm':                  { en: 'Pin the just-downloaded cert anyway?', ru: 'Всё равно закрепить только что скачанный cert?' },

  // Untrusted-cert select prompts
  'select.whatToDo':                   { en: 'What to do?', ru: 'Что делать?' },
  'select.option.abort':               { en: 'Cancel and investigate (safe)', ru: 'Отменить и разобраться (безопасно)' },
  'select.option.reTofu':              { en: 'Re-download the chain (re-TOFU)', ru: 'Скачать цепочку заново (re-TOFU)' },
  'select.option.useFile':             { en: 'Specify a new path to the CA file', ru: 'Указать новый путь к файлу' },
  'select.option.acceptNew':           { en: 'Accept the new cert and overwrite the chain', ru: 'Принять новый сертификат и перезаписать цепочку' },
  'select.option.useFileFromAdmin':    { en: 'Use a file from the admin — I will provide the path', ru: 'Использовать файл от админа — укажу путь' },
  'select.option.accept':              { en: 'Accept and save the chain to ~/.openclaw/trueconf-ca.pem', ru: 'Принять и сохранить цепочку в ~/.openclaw/trueconf-ca.pem' },
  'select.option.useFileFreshTofu':    { en: 'I have a cert file from the admin — I will provide the path', ru: 'У меня есть файл сертификата от админа — укажу путь' },
  'select.option.abortSetup':          { en: 'Cancel setup', ru: 'Отменить настройку' },

  // Probe prompts
  'probe.detecting':                   { en: 'Detecting TLS/port...', ru: 'Определяю TLS/порт...' },
  'probe.title':                       { en: 'Server check', ru: 'Проверка сервера' },
  'probe.skipped':                     { en: 'Probe could not detect TLS/port ({{error}}).\nTrying HTTPS on port 443 — if that fails, OAuth will return the exact reason.', ru: 'Probe не смог определить TLS/порт ({{error}}).\nПробую HTTPS на порту 443 — если не сработает, OAuth вернёт точную причину.' },
  'probe.skippedTitle':                { en: 'Probe skipped', ru: 'Probe пропущен' },

  // OAuth prompts
  'oauth.invalidPassword':             { en: 'Invalid password ({{attempt}}/3)', ru: 'Неверный пароль ({{attempt}}/3)' },
  'oauth.title':                       { en: 'OAuth', ru: 'OAuth' },
  'oauth.passwordRetry':               { en: 'Enter password again', ru: 'Введите пароль ещё раз' },
  'oauth.error':                       { en: 'OAuth error: {{error}}', ru: 'OAuth error: {{error}}' },
  'oauth.errorTitle':                  { en: 'Error', ru: 'Ошибка' },

  // Connected
  'connected.body':                    { en: 'Connected as {{username}}', ru: 'Подключено как {{username}}' },
  'connected.title':                   { en: 'TrueConf ready', ru: 'TrueConf ready' },
} as const

export type TranslationKey = keyof typeof TRANSLATIONS
export const TRANSLATION_KEYS = Object.keys(TRANSLATIONS) as TranslationKey[]

export function t(
  key: TranslationKey,
  locale: Locale,
  vars?: Record<string, string | number>,
): string {
  const entry = TRANSLATIONS[key]
  if (!entry) throw new Error(`unknown translation key: ${key}`)
  let out: string = entry[locale] ?? entry[DEFAULT_LOCALE]
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{{${k}}}`, String(v))
    }
  }
  return out
}
