<p align="center">
  <img src="assets/cover.png" alt="TrueConf-OpenClaw-Channel" width="800" height="auto">
</p>

<h1 align="center">Канал OpenClaw для TrueConf Server</h1>

<p align="center">Подключите <a href="https://openclaw.ai/">OpenClaw</a> к корпоративному <a href="https://trueconf.ru/products/tcsf/besplatniy-server-videoconferenciy.html">мессенджеру Труконф</a>. </p>

<p align="center">
    <a href="https://www.npmjs.com/package/@trueconf-community/trueconf-openclaw-channel" target="_blank">
      <img alt="NPM Version" src="https://img.shields.io/npm/v/%40trueconf-community%2Ftrueconf-openclaw-channel">
    </a>
    <img alt="NPM Downloads" src="https://img.shields.io/npm/d18m/%40trueconf-community%2Ftrueconf-openclaw-channel?label=Downloads">
    <a href="https://t.me/trueconf_talks" target="_blank">
        <img src="https://img.shields.io/badge/Telegram-2CA5E0?logo=telegram&logoColor=white" />
    </a>
    <a href="#">
        <img src="https://img.shields.io/github/stars/trueconf/trueconf-openclaw-channel?style=social" />
    </a>
</p>

<p align="center">
  <a href="./README.md">English</a> /
  <a href="./README-ru.md">Русский</a>
</p>

Канал для подключения OpenClaw к корпоративному мессенджеру TrueConf. После установки ИИ-агент OpenClaw общается с пользователями через TrueConf — сообщения, отправленные боту, передаются ИИ-агенту, а ответы приходят обратно в чат.

```
[TrueConf клиент]  ->  [TrueConf Server]  ->  [OpenClaw + плагин]  ->     [LLM]
    пишешь              Chatbot Connector       получает сообщение      генерирует
   сообщение                                     передаёт в LLM           ответ
```

## Возможности агента

С помощью этого канала OpenClaw умеет:

- **Работать в групповых чатах** — отвечает в группе только когда его упомянули через @ или ответили на его сообщение (смотрите раздел [Групповые чаты](#групповые-чаты))
- **Работать через федерацию** — бот на одном TrueConf-сервере отвечает пользователям с других серверов по федерации (см. раздел [Межсерверная федерация](#межсерверная-федерация))
- **Переживать обрывы соединения** — исходящие сообщения паркуются на время WS-реконнекта и ротации токена, доставляются после re-auth (без ручного retry, ничего не теряется)

## Требования

- **OpenClaw** >= 2026.3.22
- **TrueConf Server** >= 5.5.3 
- **Учётная запись бота** на TrueConf Server 

## Установка

Предварительно нужны: `node >= 22.14`, `npm`, `openclaw` (`npm install -g openclaw@latest`).

### Из npm (рекомендуется)

```bash
openclaw plugins install @trueconf-community/trueconf-openclaw-channel
npx -y -p @trueconf-community/trueconf-openclaw-channel trueconf-setup
openclaw gateway
```

`trueconf-setup` — мастер установки канала: спрашивает URL сервера, логин и пароль бота, проверяет TLS и OAuth, записывает результат в `~/.openclaw/openclaw.json`.

### Из исходного кода 

```bash
git clone https://github.com/TrueConf/trueconf-openclaw-channel.git
cd trueconf-openclaw-channel
npm install
openclaw plugins install -l .
npm run setup      
openclaw gateway
```

### Docker / Ansible / CI

Задайте переменные окружения перед `trueconf-setup` — мастер установки увидит их и пропустит все вопросы:

```bash
export TRUECONF_SERVER_URL=tc.example.com
export TRUECONF_USERNAME=bot_user              # только логин учетной записи, без адреса сервера
export TRUECONF_PASSWORD=secret
export TRUECONF_USE_TLS=true                   # опционально; по умолчанию — auto-detect
export TRUECONF_PORT=443                       # опционально; любой порт 1-65535
export TRUECONF_ACCEPT_UNTRUSTED_CA=true       # обязательно если cert самоподписанный и мастер установки должен его скачать

openclaw plugins install @trueconf-community/trueconf-openclaw-channel
npx -y -p @trueconf-community/trueconf-openclaw-channel trueconf-setup
openclaw gateway
```

Без `TRUECONF_ACCEPT_UNTRUSTED_CA=true` мастер установки при встрече самоподписанного сертификата завершится с ошибкой `Self-signed cert detected; set TRUECONF_ACCEPT_UNTRUSTED_CA=true to auto-download chain`.

### Повторный запуск настройки

Вы можете запустить `trueconf-setup` повторно. Вы можете изменить и сохранить определенные значения полей, если необходимо.

### Самоподписанные сертификаты

Если у TrueConf Server самоподписанный или выданный внутренним CA сертификат, мастер предлагает три пути доверия (по убыванию безопасности):

1. **`caPath`** — указать файл CA от админа. Впишите `"caPath": "/path/to/server-ca.pem"` в конфиг или выберите «Указать путь к корневому сертификату (CA)» в интерактивном мастере.
2. **`NODE_EXTRA_CA_CERTS` / системный trust store** — добавить CA в OS или Node trust store; probe увидит cert как доверенный, и `caPath` не нужен.
3. **`tlsVerify: false`** — последнее средство, отключает проверку только для этого TrueConf Server. Выберите «Отключить проверку TLS-сертификата для этого TrueConf Server» в мастере, впишите `"tlsVerify": false` в конфиг, или передайте `TRUECONF_TLS_VERIFY=false` в headless-настройку.

См. [TLS trust для TrueConf Server](#tls-trust-для-trueconf-server) ниже — там полная инструкция и оговорки по безопасности, включая почему ни в коем случае нельзя ставить `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### Проверка работы канала

В логах должно появиться:

```
[trueconf] Connected and authenticated
```

Откройте приложение Труконф, найдите бота в контактах и напишите ему сообщение. 

### Настраиваете через ИИ-ассистента?

Дайте ассистенту ссылку на [`llms.txt`](./llms.txt) (короткий индекс) или вставьте содержимое [`llms-full.txt`](./llms-full.txt) в чат — для полного контекста, привязанного к актуальной версии плагина.

## Настройка

### Одна учетная запись бота

```json
{
  "channels": {
    "trueconf": {
      "serverUrl": "trueconf.example.com",
      "username": "bot_user",
      "password": "bot_password",
      "useTls": true,
      "port": 443
    }
  }
}
```

`port` опционален — без него канал использует значение по умолчанию (443 для `useTls:true`, 4309 для `useTls:false`). Полный список полей — в [справочнике](#справочник-полей-аккаунта-accountsid-или-плоский-trueconf) ниже.

### Несколько учетных записей бота

```json
{
  "channels": {
    "trueconf": {
      "accounts": {
        "main-office": {
          "serverUrl": "trueconf.example.com",
          "username": "bot_user",
          "password": "bot_password",
          "useTls": true
        },
        "branch-office": {
          "serverUrl": "branch.example.com",
          "username": "bot_branch",
          "password": "bot_branch_password",
          "useTls": false,
          "port": 5309
        }
      },
      "dmPolicy": "allowlist",
      "allowFrom": ["user1@trueconf.example.com", "user2@trueconf.example.com"],
      "maxFileSize": 10485760
    }
  }
}
```

> **Важно:** поля `dmPolicy`, `allowFrom`, `maxFileSize` живут на уровне `channels.trueconf`, а **не** внутри конкретного аккаунта. Если разместить их внутри `accounts.*`, канал проигнорирует их и использует значения по умолчанию

### Справочник полей сервера

| Поле | Тип | Обязательное | По умолчанию | Описание |
|------|-----|--------------|--------------|----------|
| `serverUrl` | string | Да | — | Адрес TrueConf Server (например, `10.0.0.1` или `trueconf.example.com`) |
| `username` | string | Да | — | Имя учётной записи бота на сервере (например, `bot_user`)|
| `password` | string \| `{ useEnv: string }` | Да | — | Пароль бота. Либо строка, либо ссылка на env var: `"password": { "useEnv": "TRUECONF_PASSWORD" }` |
| `useTls` | boolean | Да | — | `true` — подключение по wss/https; `false` — по ws/http. |
| `port` | number | Нет | `443` при `useTls:true`, `4309` при `useTls:false` | Порт TrueConf Server (1-65535). |
| `clientId` | string | Нет | `"chat_bot"` | OAuth client_id. Переопределять только если сервер настроен на нестандартный chatbot client |
| `clientSecret` | string | Нет | `""` | OAuth client_secret. Большинство инсталляций TrueConf Server используют public client (secret пустой) |
| `caPath` | string | Нет | — | Путь к PEM-файлу с сертификатом TrueConf Server. Нужен если сервер использует самоподписанный или корпоративный CA |
| `tlsVerify` | boolean | Нет | `true` | При `false` отключает проверку TLS-сертификата **только для этого TrueConf-аккаунта** (per-undici/per-ws). Last-resort режим для самоподписанных серверов; не использовать в production. Несовместим с `caPath` — мастер очищает неиспользуемое поле при смене режима |
| `setupLocale` | `"en"` \| `"ru"` | Нет | `en` | Язык интерфейса мастера. Заполняется автоматически при первом запуске `trueconf-setup`; можно править вручную или переопределить через `TRUECONF_SETUP_LOCALE=en\|ru`. Логи рантайма всегда английские |
| `enabled` | boolean | Нет | `true` | Если false, аккаунт не будет работать с gateway, но сохранится в конфиге |

### Справочник полей канала 

| Поле | Тип | По умолчанию | Описание |
|------|-----|--------------|----------|
| `dmPolicy` | string | `"open"` | Политика доступа к личным диалогам: `"open"` (все), `"allowlist"` (только из `allowFrom`), `"closed"` / `"disabled"` (никто). `"pairing"` зарезервировано под будущую функциональность, сейчас работает как `"open"` |
| `allowFrom` | string[] | — | Список TrueConf ID (`user@server`), которым разрешено писать боту в личные сообщения при `dmPolicy: "allowlist"` |
| `maxFileSize` | number (байты) | `52428800` (50 МБ) | Максимальный размер одного файла. Применяется к входящим и исходящим файлам одинаково. Диапазон 1 байт — 2 ГБ; при выходе из диапазона канал пишет `[trueconf] Invalid maxFileSize: ...` в лог и использует значение по умолчанию |
| `groupAlwaysRespondIn` | string[] | `[]` | Список названий и/или chatId групп, где бот отвечает на каждое сообщение, минуя mention/reply gate. Форматы: `<name>`, `title:<name>`, `chatId:<id>`. См. раздел [«Чаты, где бот всегда отвечает»](#чаты-где-бот-всегда-отвечает) выше |

### Режим TLS

`useTls` выбирает протокол 

| `useTls` | Протоколы | Дефолтный порт | Когда использовать |
|----------|-----------|----------------|---------------------|
| `true` | `wss://` + `https://` | `443` | TrueConf Server с TLS — через Web Manager (443), или кастомный TLS-порт (8443, 9443, ...) |
| `false` | `ws://` + `http://` | `4309` | TrueConf Bridge без TLS — типично во внутренних сетях, или через обратный прокси |

Адреса, которые строит плагин:
- OAuth token: `{scheme}://{serverUrl}[:{port}]/bridge/api/client/v1/oauth/token`
- WebSocket: `{wsScheme}://{serverUrl}[:{port}]/websocket/chat_bot/`


## Аутентификация

Плагин использует **OAuth 2.0 Password Grant** для получения токена, и передаёт полученный **JWT** в WebSocket auth-пакет.

```
1. POST /bridge/api/client/v1/oauth/token
   { "client_id": "chat_bot", "client_secret": "",
     "grant_type": "password", "username": "...", "password": "..." }
   → { "access_token": "<JWT>", "expires_at": 1234567890, ... }

2. WS /websocket/chat_bot/
   → { "type": 1, "method": "auth", "payload": { "token": "<JWT>", "tokenType": "JWT" } }
```

Токен автоматически обновляется за минуту до `expires_at` — пользователю делать ничего не нужно, переподключения прозрачны.

## TLS trust для TrueConf Server

TrueConf Server обычно разворачивается on-prem с сертификатом от внутреннего CA или самоподписанным вариантом. Канал предлагает три явных пути доверия по убыванию безопасности:

### 1. System trust (по умолчанию, ничего делать не надо)

Публичные сертификаты (Let's Encrypt и т.п.) работают из коробки. Для внутреннего CA — добавить корневой сертификат в trust store ОС или Node:

- **MDM / GPO / Ansible** — админ пушит CA-сертификат в `/usr/local/share/ca-certificates/` (Linux) или аналог, затем `update-ca-certificates`.
- **`NODE_EXTRA_CA_CERTS`** — в systemd unit, Dockerfile `ENV` или shell profile:
  ```bash
  export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-ca.pem
  ```

Probe видит `authorized: true`, мастер не задаёт trust-вопросов.

### 2. `caPath` — корневой CA от админа (рекомендуется)

Если администратор TrueConf Server выдал вам корневой CA в формате PEM, укажите путь к нему:

- **Интерактивно**: на trust-prompt'е выберите «Указать путь к корневому сертификату (CA)» и введите путь.
- **В конфиге**: `"caPath": "/path/to/server-ca.pem"` в `~/.openclaw/openclaw.json`.
- **Headless / CI / Docker / systemd**: `export TRUECONF_CA_PATH=/etc/trueconf/ca.pem` перед `trueconf-setup`.

Мастер валидирует файл (парсит как PEM и проверяет, что он реально валидирует живой сервер) до продолжения. При ошибке setup прерывается с конкретной причиной.

> На TrueConf Server сертификат обычно лежит как `*.crt`. Если файл в формате PEM, его можно переименовать в `*.pem`. Если вы владелец сервера, ищите сертификат в панели управления TrueConf Server в разделе HTTPS.

### 3. `tlsVerify: false` — отключить проверку сертификата (last resort)

Для самоподписанных серверов в безопасных или ограниченных средах, где получить CA непрактично:

- **Интерактивно**: на trust-prompt'е выберите «Отключить проверку TLS-сертификата для этого TrueConf Server» и подтвердите MITM-предупреждение.
- **В конфиге**: `"tlsVerify": false` в `channels.trueconf` (или per-account).
- **Headless**: `export TRUECONF_TLS_VERIFY=false` перед `trueconf-setup`.

Опция per-TrueConf only — все остальные HTTPS-вызовы из Node (LLM-провайдер, webhook'и и т.п.) продолжают проверяться. Установка `tlsVerify:false` вместе с `caPath` отклоняется; `TRUECONF_TLS_VERIFY=false` вместе с `TRUECONF_CA_PATH` тоже отклоняется.

> **Безопасность.** Отключение проверки открывает TrueConf-трафик для MITM. Используйте этот режим только в безопасной или ограниченной среде (offline-лаб, доверенная внутренняя сеть).

### Повторный запуск мастера настройки

На каждом последующем запуске `trueconf-setup` сохранённый режим доверия заново проверяется против живого сервера. Три исхода:

- **Silent happy** — сохранённый `caPath` всё ещё валидирует сервер, либо `tlsVerify:false` всё ещё в силе → без prompt'ов.
- **Trust anchor mismatch** — сохранённый CA больше не валидирует (ротация cert'а или MITM). Баннер показывает оба отпечатка и предлагает: *Отменить / Принять новый cert / Использовать файл от админа*. **Обязательно сверьте новый отпечаток с админом по отдельному каналу до accept'а.**
- **Missing trust anchor** — файла, указанного в конфиге, нет на диске. Баннер предлагает: *Отменить / Скачать цепочку заново (legacy) / Указать файл от админа*. Если файл удалил злоумышленник, re-download примет то, что сейчас отдаёт сервер — сверьте до.

### Headless-режим

`runHeadlessFinalize` (неинтерактивный setup с env-переменными `TRUECONF_SERVER_URL`/`_USERNAME`/`_PASSWORD`) повторяет trust-пути выше, но все failure-case'ы fatal — без prompt'ов и recovery:

- `TRUECONF_CA_PATH=/etc/trueconf/ca.pem` — предпочтительно для production CI/Docker.
- `TRUECONF_TLS_VERIFY=false` — last-resort режим. Несовместим с `TRUECONF_CA_PATH`.
- `TRUECONF_ACCEPT_UNTRUSTED_CA=true` — legacy опция автоскачивания цепи сервера в `~/.openclaw/trueconf-ca.pem`. **Использовать только в доверенных сетях**; где возможен MITM, используйте `TRUECONF_CA_PATH` или `TRUECONF_TLS_VERIFY=false`.

### Язык мастера настройки

Мастер по умолчанию **английский**. На первом запуске спрашивает `English` или `Russian`; выбор сохраняется в `channels.trueconf.setupLocale`, повторно не спрашивает. Переопределить можно через `TRUECONF_SETUP_LOCALE=en|ru` (env > cfg; некорректное значение → fail-fast). Логи рантайма gateway всегда английские.

## Групповые чаты

Канал работает в групповых чатах. В отличие от личных диалогов, где бот отвечает на каждое сообщение, **в группе бот реагирует только на явное обращение**:

- **@-упоминание**
- **ответ на сообщение бота** — нажмите «Ответить» на одно из последних сообщений бота. Буфер: 50 последних сообщений бота на чат.

Сообщения без ответа и упоминания бот видит, но не отвечает на них. В логе будет строка `[trueconf] group <chatId>: no mention/reply, dropping`.

**Технические детали:**

- Тип чата определяется через `getChatByID` при первом сообщении в новый чат и кешируется до перезапуска gateway. 
- Каждая группа = одна общая сессия. История разговора у бота общая на всю группу, не персональная на участника. `senderId` каждого сообщения сохраняется, чтобы LLM знал, кто пишет.
- Параметр `dmPolicy` действует только в личных диалогах. В группах фильтрация — только через mention/reply.
- Каналы TrueConf (`chatType=6`) игнорируются — бот не реагирует на сообщения в них. В логе: `[trueconf] dropping channel message chatId=<id>`.

### Чаты, где бот всегда отвечает

По умолчанию в группах бот реагирует только на @-упоминание или ответ. Чтобы бот отвечал на каждое сообщение в конкретном чате, укажите его в `groupAlwaysRespondIn`:

```json
{
  "channels": {
    "trueconf": {
      "groupAlwaysRespondIn": [
        "HR-вопросы",
        "title:#devops",
        "chatId:51ffe1b1-1515-498e-8501-233116adf9da"
      ]
    }
  }
}
```

**Форматы элемента:**

- `<name>` — название чата (по умолчанию). Ведущие/хвостовые пробелы и регистр нормализуются; внутренние пробелы сохраняются.
- `title:<name>` — явно название (полезно, если название выглядит как chatId).
- `chatId:<id>` — явно chatId. Префикс обязателен — без него строка трактуется как название.

**Где взять chatId:** в логах плагина при первом сообщении из чата будет строка `[trueconf] group <chatId> ...` — скопируйте значение `<chatId>`.

**Поведение при старте:** плагин запрашивает у TrueConf полный список чатов бота и матчит названия. Если название не нашлось — это не ошибка: возможно, бота ещё не добавили в группу, и bypass активируется автоматически через push-события, когда он присоединится.

**Переименования:** если группу переименовали, плагин пересчитывает bypass. Группа с новым названием из конфига становится always-respond; группа, чьё новое название не в конфиге — снимается. Diff логируется.

**Дубликаты названий:** если одно название из конфига совпало с несколькими группами, bypass применится ко всем, в логе будет warn. Для прицельности используйте `chatId:`.

**Multi-account:** список общий на канал. Название `"HR"` сматчит одноимённую группу в каждом аккаунте, где она есть. `chatId` глобально уникален на TrueConf-сервере — если два аккаунта состоят в одной группе, chatId одинаков.

**Ограничения:**

- Активируется только для групп (`chatType=2`). Каналы (`chatType=6`) не активируются.
- Если `getChats` падает при старте, title-entries остаются неактивны до следующего успешного reconnect — `chatId:` работает всегда.
- Конфиг не hot-reload'ится; перезапустите gateway после изменений.

## Мультиаккаунт: поведение

Если в конфиге несколько аккаунтов (`accounts.office`, `accounts.support`, ...):

- Каждый аккаунт получает собственное WebSocket-подключение, собственный CA-trust, собственный буфер last-inbound-route и recent-bot-messages.
- Падение одного аккаунта не влияет на остальные: gateway логирует `[trueconf] Account <id> startup failed: ...` и продолжает поднимать другие.
- Маршрутизация исходящих ответов — по `ctx.accountId`. LLM должен знать, от какого аккаунта отвечать; обычно это выводится из входящего `accountId`.
- Поля `dmPolicy`, `allowFrom`, `maxFileSize` — общие для всех аккаунтов (на уровне `trueconf.*`). Per-account вариант не поддерживается.

## Медиа-файлы и лимиты

Канал принимает и отправляет файлы через TrueConf: изображения, аудио, видео и документы. Размер ограничивается `maxFileSize` (см. справочник полей канала). По умолчанию — 50 МБ.

## Отличия от python-trueconf-bot

Канал wire-совместим с [python-trueconf-bot](https://github.com/trueconf/python-trueconf-bot) — оба говорят по протоколу TrueConf Chatbot Connector. Несколько user-visible различий — намеренные:

| Поведение | Этот канал | python-trueconf-bot | Почему |
|-----------|------------|---------------------|--------|
| Рендеринг текста по умолчанию | `parseMode: 'markdown'` | `ParseMode.TEXT` | LLM по умолчанию выдают markdown; рендеринг в TrueConf даёт пользователю отформатированный вывод без дополнительной настройки. |
| Длинный текст (> 4096 символов) | Auto-split на чанки (абзац → предложение → жёсткий разрез), порядок сохраняет per-chat очередь | Обрезается на стороне сервера | Ответы LLM регулярно перерастают лимит; абзац-first сплиттер бережнее к markdown-разметке. |
| Длинная подпись (> 4096 символов) | Отдельным сообщением перед файлом; файл уходит без caption | Тот же вход обрезается сервером | Best-effort: если `sendFile` упадёт после успешной отправки подписи, канал явно логирует orphan-текст. |
| Ошибки DNS (`ENOTFOUND`, `EAI_AGAIN`, …) | 5 попыток (≈ 31 с), затем fail-fast | Повторяет бесконечно | Внутри OpenClaw runtime неразрешимый хост почти всегда = опечатка в `serverUrl`; явно показать ошибку полезнее, чем retry'ить вечно. |
| Истечение токена (`errorCode: 203`) на любом RPC | Transport-level реконнект со свежим OAuth + прозрачный retry исходного запроса | User-level паттерн `examples/update_token.py` | Плагин не должен требовать example-кода, чтобы оставаться online. |
| Исходящие во время WS-реконнекта или auth failure | Паркуются в in-memory очереди, drain'ятся после следующего успешного auth | Отклоняются вызывающему; retry на стороне кода | Кратковременные обрывы WS и ротация токена не должны терять user-visible ответы, а приложение не должно реализовывать собственный retry-буфер. |

Callback `setChatMutationHandler` (события edit / remove / clearHistory) сейчас не экспонируется — push-события парсятся и логируются, но не диспатчатся наверх.

## Переменные окружения

Шесть тюнингов сетевой устойчивости с разумными дефолтами. Все читаются **при загрузке модуля** (когда gateway импортирует плагин), поэтому должны быть выставлены до старта gateway. Изменение на лету требует перезапуска gateway. Невалидные значения (не-число, ноль, отрицательное) тихо откатываются на дефолт.

| Переменная | Дефолт | Единицы | Смысл |
|---|---|---|---|
| `TRUECONF_HEARTBEAT_INTERVAL_MS` | `30000` | мс | Интервал между ping-фреймами на TrueConf Server. Уменьшайте для корпоративных NAT с idle-таймаутом меньше 30с. |
| `TRUECONF_HEARTBEAT_PONG_TIMEOUT_MS` | `10000` | мс | Если два pong'а подряд не приходят в этом окне — соединение считается мёртвым и переподключается. |
| `TRUECONF_OAUTH_TIMEOUT_MS` | `15000` | мс | Wall-clock бюджет на POST OAuth-токена. Ограничивает время удержания lifecycle на повисшем reverse-proxy до backoff'а. |
| `TRUECONF_WS_HANDSHAKE_TIMEOUT_MS` | `20000` | мс | Wall-clock бюджет от `new WebSocket(...)` до первого события `'open'` (TLS + WS upgrade). По истечении сокет терминируется и запускается reconnect-loop. |
| `TRUECONF_DNS_FAIL_LIMIT` | `5` | штук | Кумулятивных DNS-ошибок (`ENOTFOUND`, `EAI_AGAIN`, `EAI_NODATA`, `EAI_NONAME`) за реконнект, после которых срабатывает терминальный `dns_unreachable`. |
| `TRUECONF_OAUTH_FAIL_LIMIT` | `3` | штук | Подряд идущих 401/403 от OAuth-эндпоинта, после которых срабатывает терминальный `oauth_unauthorized`. Счётчик сбрасывается на любой не-401/403 ответ. |

## Устранение неполадок

### `fetch failed` при запуске

- **Причина:** Сертификат TrueConf Server не от публичного CA (самоподписанный или от корпоративного CA), Node.js ему не доверяет.
- **Решение:** Перезапустите `trueconf-setup`. Выберите «Указать путь к корневому сертификату (CA)» и укажите `.pem` от админа сервера (предпочтительно), либо «Отключить проверку TLS-сертификата для этого TrueConf Server», если вы готовы принять MITM-риск для этого транспорта (last resort). Можно также вручную указать `"caPath": "/path/to/ca.pem"` или `"tlsVerify": false` в конфиге, либо экспортировать `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` для system-wide trust. См. [TLS trust для TrueConf Server](#tls-trust-для-trueconf-server).
- **Чего не стоит делать:** `NODE_TLS_REJECT_UNAUTHORIZED=0` отключает проверку TLS для **всего** Node-процесса, включая запросы к LLM-провайдеру и любым другим endpoint'ам. Если нужен insecure-режим — используйте per-account `tlsVerify: false` выше, он ограничен только TrueConf-трафиком.

### `blocked URL fetch ... resolves to private/internal/special-use IP address`

- **Причина:** Корпоративный прокси или VPN перенаправляет запросы к LLM-провайдеру (например, api.openai.com) на внутренний адрес.
- **Решение:** Настройте прокси (`HTTPS_PROXY`) или используйте локальную модель через Ollama.

### `Missing API key for provider "openai"`

- **Причина:** Не настроен LLM-провайдер.
- **Решение:** Запустите `openclaw configure` и выберите провайдера (OpenAI, Ollama и т.д.).

### Неверные учётные данные

- **Симптом:** `OAuth token acquisition failed (401): invalid_grant` в логах.
- **Причина:** Неверный `username` или `password` в конфиге.
- **Решение:** Проверьте, что `username` — это только имя учётки (`bot_user`), без `@сервер.trueconf.name`; адрес сервера указывается отдельно в `serverUrl`. Убедитесь, что учётная запись активна в панели администратора TrueConf Server. Если TrueConf Server настроен на нестандартный OAuth client — пропишите `clientId` и `clientSecret` в конфиге.

### Несовпадение TLS

- **Симптом:** `WebSocket error: connect ECONNREFUSED` сразу после запуска.
- **Причина:** `useTls` не соответствует конфигурации сервера, либо указан неверный `port`.
- **Решение:** Убедитесь что `useTls` совпадает с протоколом сервера (TLS ↔ true). Если порт нестандартный — укажите поле `port` явно. См. [Режим TLS](#режим-tls).

### Порт заблокирован файрволом

- **Симптом:** `WebSocket error: connect ECONNREFUSED` или `ETIMEDOUT` при валидных `serverUrl`/`useTls`.
- **Причина:** Файрвол блокирует выбранный порт (4309, 443 или кастомный).
- **Решение:** Откройте нужный порт на файрволе, или переключитесь на другой порт/режим (Web Manager на 443 с `useTls:true`, Bridge на 4309 с `useTls:false`, кастомный порт через поле `port`).

### Бот подключается, но не отвечает

- **Симптом:** В логах `Connected and authenticated`, но ответов нет.
- **Возможные причины:**
  1. Вы пишете боту из-под того же аккаунта — нужно писать от **другого** пользователя.
  2. Сообщение в групповом чате без @-mention и без reply на бота — в группе нужно явно обратиться (см. раздел [Групповые чаты](#групповые-чаты)). В логе будет строка `group <chatId>: no mention/reply, dropping`.
  3. Сообщение в TrueConf-канале (`chatType=6`) — бот их игнорирует. В логе: `dropping channel message chatId=<id>`.
  4. `dmPolicy: "allowlist"` и отправитель не в `allowFrom`. В логе: `DM blocked for <id> by policy`.
  5. LLM-провайдер не настроен — запустите `openclaw configure`.
  6. LLM-провайдер недоступен из сети — проверьте доступ или используйте Ollama.

### Бот шлёт фото без подписи

- **Симптом:** Агент отвечает «Держи кота 🐱» с прикреплённой картинкой, в TrueConf-чате приходит только фото, текст пропадает.
- **Причина:** В openclaw `2026.4.22` при `agents.defaults.blockStreamingDefault: "off"` (или когда поле не задано — это значение по умолчанию) подпись и медиа разделяются на разные блоки, и текстовая часть теряется в финальном фильтре before деливерa плагину.
- **Решение:**
  ```bash
  openclaw config set agents.defaults.blockStreamingDefault on
  openclaw config set agents.defaults.blockStreamingBreak message_end
  ```
  Затем перезапустите gateway. Агент будет отдавать текст и медиа одним блоком, плагин пришлёт фото с подписью.

### Частые реконнекты

- **Симптом:** `[trueconf] Connection closed, scheduling reconnect` повторяется в логах.
- **Причина:** Обрыв WebSocket-соединения на уровне сети. Heartbeat работает как ping/pong с 20-секундным интервалом — если два подряд pong'а не приходят в течение 20 секунд, соединение считается мёртвым и плагин переподключается. 
- **Решение:** Проверьте стабильность сети до TrueConf Server, traceroute, MTU, корпоративный прокси/VPN между клиентом и сервером. Если между плагином и сервером есть reverse-proxy (nginx, haproxy) — убедитесь что таймауты WebSocket idle-соединения там достаточно большие.
- **Исходящие во время реконнекта:** сообщения, отправленные пока WS лежит, паркуются в памяти и доставляются после следующего успешного auth — ответы не теряются между реконнектами, только задерживаются. В логах ищите `[trueconf] outbound qid=<id>` с трассировкой `submit → wait_auth → wire_send → ack`.


### Поиск логов

Все сообщения плагина имеют префикс `[trueconf]`. Для фильтрации:

**Linux/macOS:**

```bash
openclaw gateway 2>&1 | grep '\[trueconf\]'
```

**Windows (PowerShell):**

```powershell
openclaw gateway | Select-String '\[trueconf\]'
```

Лог-файл: путь указан в выводе gateway (`[gateway] log file: ...`).

## Тестирование

```bash
npm test
```

## Лицензия

MIT
