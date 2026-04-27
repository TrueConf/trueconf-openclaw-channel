// Translation table for the TrueConf setup wizard (interactive + headless).
// Keys are flat strings; every entry has both `en` and `ru` text. The
// runtime resolution layer is responsible for picking the locale; this
// module just throws on unknown keys so missing copy fails loudly in tests.

export type Locale = 'en' | 'ru'
export const DEFAULT_LOCALE: Locale = 'en'

const TRANSLATIONS = {
  // Language selection
  'language.prompt':                   { en: 'Language:', ru: 'Language:' },
  'language.option.en':                { en: 'English', ru: 'English' },
  'language.option.ru':                { en: 'Russian', ru: 'Russian' },
  'locale.invalidEnv':                 { en: "TRUECONF_SETUP_LOCALE must be 'en' or 'ru', got: {{value}}", ru: "TRUECONF_SETUP_LOCALE должно быть 'en' или 'ru', получено: {{value}}" },

  // TLS untrusted cert flow titles + hints (seeded for Tasks 5/6)
  'tls.untrusted.title':               { en: 'Untrusted TLS certificate', ru: 'Недоверенный TLS-сертификат' },
  'tls.untrusted.choice.use-file':     { en: 'Specify path to a root CA certificate', ru: 'Указать путь к корневому сертификату (CA)' },
  'tls.untrusted.choice.insecure':     { en: 'Disable TLS certificate verification for this TrueConf Server', ru: 'Отключить проверку TLS-сертификата для этого TrueConf Server' },
  'tls.cafile.hint.intro':             { en: 'Specify the path to a root CA certificate in PEM format.', ru: 'Укажите путь к корневому сертификату CA в PEM-формате.' },
  'tls.cafile.hint.format':            { en: 'On TrueConf Server the certificate is usually stored as *.crt. If the file is in PEM format you can rename it to *.pem.', ru: 'На TrueConf Server сертификат обычно лежит как *.crt. Если файл в формате PEM, его можно переименовать в *.pem.' },
  'tls.cafile.hint.location':          { en: 'If you own the server, find the certificate in the TrueConf Server control panel under HTTPS.', ru: 'Если вы владелец сервера, ищите сертификат в панели управления TrueConf Server в разделе HTTPS.' },
  'tls.cafile.unreadable':             { en: 'Cannot read CA file at {{path}}: {{reason}}', ru: 'Не могу прочитать файл CA по пути {{path}}: {{reason}}' },
  'tls.cafile.envUnreadable':          { en: 'TRUECONF_CA_PATH={{path}}: cannot read ({{reason}})', ru: 'TRUECONF_CA_PATH={{path}}: не могу прочитать ({{reason}})' },
  'tls.cafile.envNotPem':              { en: 'TRUECONF_CA_PATH={{path}}: not PEM. DER/P7B not supported — convert: openssl x509 -in file -inform DER -out file.pem', ru: 'TRUECONF_CA_PATH={{path}}: не PEM. DER/P7B не поддерживаются — конвертируй: openssl x509 -in file -inform DER -out file.pem' },
  'tls.cafile.envUnreachable':         { en: 'TRUECONF_CA_PATH={{path}}: cannot reach {{host}}:{{port}} — {{error}}. CA cannot be checked while the server is unreachable.', ru: 'TRUECONF_CA_PATH={{path}}: не могу подключиться к {{host}}:{{port}} — {{error}}. CA не проверить пока сервер недоступен.' },
  'tls.cafile.envWrongCa':             { en: 'TRUECONF_CA_PATH={{path}}: file does not validate this server. Trust anchor in file: {{fileIssuer}}; server presents cert issued by {{serverIssuer}}. TLS error: {{error}}', ru: 'TRUECONF_CA_PATH={{path}}: файл не валидирует этот сервер. Trust anchor в файле: {{fileIssuer}}; сервер отдаёт cert с издателем {{serverIssuer}}. TLS error: {{error}}' },
  'tls.insecure.warning':              { en: 'The connection to TrueConf will be established without TLS certificate verification. This may enable a MITM attack. Use this mode only in a safe or restricted environment; verification stays on for the rest of Node.js.', ru: 'Соединение с TrueConf будет установлено без проверки TLS-сертификата. Это может позволить MITM-атаку. Используйте этот режим только в безопасной или ограниченной среде; для остального Node.js проверка остаётся включённой.' },
  'tls.insecure.confirm':              { en: 'Disable TLS certificate verification?', ru: 'Отключить проверку TLS-сертификата?' },
  'tls.insecure.invalidEnv':           { en: "TRUECONF_TLS_VERIFY must be 'false' or unset, got: {{value}}", ru: "TRUECONF_TLS_VERIFY должно быть 'false' или не задано, получено: {{value}}" },
  'tls.insecure.conflict':             { en: 'TRUECONF_CA_PATH and TRUECONF_TLS_VERIFY=false are incompatible — pick one trust mode.', ru: 'TRUECONF_CA_PATH и TRUECONF_TLS_VERIFY=false несовместимы — выберите один режим доверия.' },
  'tls.insecure.useTlsConflict':       { en: 'TRUECONF_USE_TLS=false and TRUECONF_TLS_VERIFY=false are incompatible — TLS verification cannot be disabled when TLS is off.', ru: 'TRUECONF_USE_TLS=false и TRUECONF_TLS_VERIFY=false несовместимы — нельзя отключать проверку TLS-сертификата, если TLS отключён.' },

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

  // Cert-block lines (used inside trust-flow banners)
  'tls.banner.cert.subjectLine':       { en: '  Subject:      {{value}}', ru: '  Владелец:     {{value}}' },
  'tls.banner.cert.issuerLine':        { en: '  Issuer:       {{value}}', ru: '  Издатель:     {{value}}' },
  'tls.banner.cert.validityLine':      { en: '  Valid:        from {{from}} to {{to}}', ru: '  Действителен: с {{from}} до {{to}}' },
  'tls.banner.cert.fingerprintLine':   { en: '  Fingerprint:  SHA-256 {{fp}}', ru: '  Отпечаток:    SHA-256 {{fp}}' },
  'tls.banner.cert.expired':           { en: 'EXPIRED', ru: 'ПРОСРОЧЕН' },
  'tls.banner.cert.noServerCert':      { en: '  (server returned no cert)', ru: '  (сервер не отдал cert)' },

  // Untrusted-cert banner (fresh TOFU)
  'tls.banner.untrusted.title':        { en: 'Confirm TrueConf cert', ru: 'Подтверждение cert TrueConf' },
  'tls.banner.untrusted.body':         { en: '⚠ TLS certificate not in the system trust store', ru: '⚠ Сертификат TLS не в системном хранилище доверенных' },
  'tls.banner.untrusted.selfSigned':   { en: '  (self-signed — typical for dev / test servers)', ru: '  (самоподписан — типично для dev/тестовых серверов)' },
  'tls.banner.untrusted.verifyAdmin':  { en: '  Verify the fingerprint with the server admin out of band\n  (messenger, phone), then choose an action.', ru: '  Сверьте отпечаток с админом сервера по отдельному каналу\n  (мессенджер, телефон), затем выберите действие.' },

  // Mismatch banner (stored anchor no longer validates the server)
  'tls.banner.mismatch.title':         { en: 'Trust anchor mismatch', ru: 'Trust anchor mismatch' },
  'tls.banner.mismatch.body':          { en: '⚠⚠ WARNING: stored trust anchor no longer validates the server', ru: '⚠⚠ ВНИМАНИЕ: сохранённый trust anchor больше не валидирует сервер' },
  'tls.banner.mismatch.storedAnchor':  { en: 'Stored trust anchor (file: {{caPath}}):', ru: 'Сохранённый trust anchor (файл: {{caPath}}):' },
  'tls.banner.mismatch.storedParseFail': { en: '  (could not parse stored chain)', ru: '  (не удалось распарсить сохранённую цепочку)' },
  'tls.banner.mismatch.serverNow':     { en: 'Server signed now (leaf):', ru: 'Сервер, подписанный сейчас (leaf):' },
  'tls.banner.mismatch.tlsStack':      { en: 'TLS stack: {{error}}', ru: 'TLS-стек: {{error}}' },
  'tls.banner.mismatch.chainBroken':   { en: "(trust chain from current cert to the stored anchor does not build)", ru: "(цепочка доверия от текущего cert'а к сохранённому anchor'у не собирается)" },
  'tls.banner.mismatch.causes':        { en: 'Possible causes:\n  • internal server CA rotated — ask the admin;\n  • man-in-the-middle attack — verify the new fingerprint\n    with the admin out of band before accepting.', ru: 'Возможные причины:\n  • смена internal CA сервера — уточни у админа;\n  • атака «человек посередине» — сверь новый отпечаток\n    с админом по отдельному каналу перед принятием.' },

  // Missing-file banner (cfg.caPath set, file not readable)
  'tls.banner.missing.title':          { en: 'Missing trust anchor', ru: 'Missing trust anchor' },
  'tls.banner.missing.body':           { en: "⚠ Stored trust-anchor file not found / not readable", ru: "⚠ Файл сохранённого trust anchor'а не найден/не читается" },
  'tls.banner.missing.expected':       { en: 'Expected: {{caPath}}', ru: 'Ожидалось:  {{caPath}}' },
  'tls.banner.missing.status':         { en: 'Status:   {{reason}}', ru: 'Статус:     {{reason}}' },
  'tls.banner.missing.serverNow':      { en: 'Server is currently presenting an untrusted certificate:', ru: 'Сервер сейчас отдаёт untrusted сертификат:' },
  'tls.banner.missing.causes':         { en: 'Possible causes:\n  • file deleted by you or the admin (planned cleanup);\n  • file deleted by an attacker to force re-TOFU\n    onto a (possibly) substituted cert;\n  • permission errors after cleanup / upgrade.', ru: 'Возможные причины:\n  • файл удалён вами или админом (плановая очистка);\n  • файл удалён злоумышленником чтобы форсировать re-TOFU\n    на (возможно) подменённый cert;\n  • permission errors после cleanup / upgrade.' },
  'tls.banner.missing.verifyAdmin':    { en: 'Verify the fingerprint with the admin BEFORE re-TOFU.', ru: 'Сверьте отпечаток сервера с админом ДО re-TOFU.' },
  'tls.banner.missing.reasonAbsent':   { en: 'file is missing', ru: 'файл отсутствует' },
  'tls.banner.missing.reasonReadErr':  { en: 'read error: {{message}}', ru: 'ошибка чтения: {{message}}' },
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
