<p align="center">
  <img src="assets/cover.png" alt="TrueConf-OpenClaw-Channel" width="800" height="auto">
</p>

<h1 align="center">Канал OpenClaw для TrueConf Server</h1>

<p align="center">Подключите <a href="https://openclaw.ai/">OpenClaw</a> к корпоративному <a href="https://trueconf.ru/products/tcsf/besplatniy-server-videoconferenciy.html">мессенджеру Труконф</a>. </p>

<p align="center">
    <a href="https://t.me/trueconf_talks" target="_blank">
        <img src="https://img.shields.io/badge/Telegram-2CA5E0?logo=telegram&logoColor=white" />
    </a>
    <a href="https://discord.gg/2gJ4VUqATZ">
        <img src="https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white" />
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

Если у TrueConf Server самоподписанный сертификат, есть три способа заставить установить его:

1. **Мастер установки скачает цепочку** (самый простой, не самый безопасный). `trueconf-setup` при обнаружении untrusted cert предложит скачать цепь в `~/.openclaw/trueconf-ca.pem` и пропишет путь в поле `caPath`. Gateway подхватит автоматически.
2. **Указать путь к CA от админа**. Если администратор TrueConf Server выдал вам `.pem`, просто впишите `"caPath": "/path/to/server-ca.pem"` в конфиг.
3. **`NODE_EXTRA_CA_CERTS`** — стандартный Node.js env var. Если сертификат уже в системном trust store или в файле, экспортированном через эту переменную, probe увидит cert как доверенный и `caPath` вообще не потребуется.

> **Безопасность** Вариант #1 — это "Trust On First Use": в момент первого запуска мастер установки доверяет любому сертификату, который показал сервер. Если в этот момент между вами и сервером активный MITM, визард сохранит сертификат злоумышленника как доверенный. Для повышения безопасности используйте вариант #2 или #3 и сверяйте SHA-256 fingerprint с администратором сервера.

### Проверка работы канала

В логах должно появиться:

```
[trueconf] Connected and authenticated
```

Откройте приложение Труконф, найдите бота в контактах и напишите ему сообщение. 

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
| `enabled` | boolean | Нет | `true` | Если false, аккаунт не будет работать с gateway, но сохранится в конфиге |

### Справочник полей канала 

| Поле | Тип | По умолчанию | Описание |
|------|-----|--------------|----------|
| `dmPolicy` | string | `"open"` | Политика доступа к личным диалогам: `"open"` (все), `"allowlist"` (только из `allowFrom`), `"closed"` / `"disabled"` (никто). `"pairing"` зарезервировано под будущую функциональность, сейчас работает как `"open"` |
| `allowFrom` | string[] | — | Список TrueConf ID (`user@server`), которым разрешено писать боту в личные сообщения при `dmPolicy: "allowlist"` |
| `maxFileSize` | number (байты) | `52428800` (50 МБ) | Максимальный размер одного файла. Применяется к входящим и исходящим файлам одинаково. Диапазон 1 байт — 2 ГБ; при выходе из диапазона канал пишет `[trueconf] Invalid maxFileSize: ...` в лог и использует значение по умолчанию |

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

TrueConf Server обычно разворачивается on-prem с сертификатом от внутреннего CA или самоподписанным вариантом. Канал поддерживает четыре пути доверия этому сертификату, в порядке предпочтения для реального развертывания:

### 1. Публичный сертификат (Let's Encrypt и подобные)

Ничего делать не надо. Мастер настройки увидит сертификат в системном trust store и пропустит TOFU.

### 2. Enterprise CA через system trust (рекомендуется для развертывания)

Сделать CA root доверенным на уровне ОС или Node:

- **MDM / GPO / Ansible** — админ пушит CA-сертификат в `/usr/local/share/ca-certificates/` (Linux) или аналог, затем `update-ca-certificates`.
- **`NODE_EXTRA_CA_CERTS`** — в systemd unit, Dockerfile `ENV` или shell profile:
  ```bash
  export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-ca.pem
  ```

Probe видит `authorized: true` и не срабатывает TOFU.

### 3. `TRUECONF_CA_PATH` env var (рекомендуется для CI / Docker / systemd)

Явно указать файл сертификата:

```bash
export TRUECONF_CA_PATH=/etc/trueconf/ca.pem
npx -y -p @trueconf-community/trueconf-openclaw-channel trueconf-setup
```

Мастер настройки валидирует файл строго (парсит как PEM + проверяет что файл реально валидирует живой сервер) до продолжения. При ошибке setup прерывается с конкретной причиной.

### 4. Interactive wizard TOFU (для быстрой локальной настройки)

Если ничего из выше не задано, мастер настройки показывает детали сертификата сервера (владелец / издатель / срок / SHA-256 отпечаток) и просит подтвердить. **Сверьте отпечаток с админом сервера по отдельному каналу** до подтверждения:

```bash
# На сервере админ запускает:
openssl x509 -in /path/to/server-cert.pem -fingerprint -sha256 -noout
```

Мастер настройки сохраняет цепь в `~/.openclaw/trueconf-ca.pem` (`0600`).

### Повторный запуск мастера настройки

На каждом последующем запуске `trueconf-setup` сохранённая цепь заново валидируется против живого сервера. Три исхода:

- **Silent happy** — сохранённый CA всё ещё валидирует сервер → без prompt'ов.
- **Trust anchor mismatch** — сохранённый CA больше не валидирует (ротация cert'а или MITM). Баннер показывает оба отпечатка (старый + новый) и предлагает: *Отменить / Принять новый cert / Использовать файл от админа*. **Обязательно сверьте новый отпечаток с админом по отдельному каналу до accept'а.**
- **Missing trust anchor** — файла, указанного в конфиге, нет на диске. Баннер предлагает: *Отменить / Скачать цепочку заново / Указать файл от админа*. Если файл удалил злоумышленник, re-download примет то, что сейчас отдаёт сервер — сверьте до.

### Headless-режим

`runHeadlessFinalize` (когда CLI вызывается неинтерактивно с env-переменными `TRUECONF_SERVER_URL`/`_USERNAME`/`_PASSWORD`) повторяет логику мастера настройки, но все failure-case'ы fatal — нет prompt'ов и recovery. Опции для headless TLS:

- `TRUECONF_CA_PATH` — предпочтительно (валидация строгая, как выше).
- `TRUECONF_ACCEPT_UNTRUSTED_CA=true` — разрешает автоскачивание цепи сервера. **Использовать только в доверенных сетях** (изолированный CI); везде, где возможен MITM, используй `TRUECONF_CA_PATH`.

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


## Мультиаккаунт: поведение

Если в конфиге несколько аккаунтов (`accounts.office`, `accounts.support`, ...):

- Каждый аккаунт получает собственное WebSocket-подключение, собственный CA-trust, собственный буфер last-inbound-route и recent-bot-messages.
- Падение одного аккаунта не влияет на остальные: gateway логирует `[trueconf] Account <id> startup failed: ...` и продолжает поднимать другие.
- Маршрутизация исходящих ответов — по `ctx.accountId`. LLM должен знать, от какого аккаунта отвечать; обычно это выводится из входящего `accountId`.
- Поля `dmPolicy`, `allowFrom`, `maxFileSize` — общие для всех аккаунтов (на уровне `trueconf.*`). Per-account вариант не поддерживается.

## Медиа-файлы и лимиты

Канал принимает и отправляет файлы через TrueConf: изображения, аудио, видео и документы. Размер ограничивается `maxFileSize` (см. справочник полей канала). По умолчанию — 50 МБ.


## Устранение неполадок

### `fetch failed` при запуске

- **Причина:** Сертификат TrueConf Server не от публичного CA (самоподписанный или от корпоративного CA), Node.js ему не доверяет.
- **Решение:** Перезапустите `trueconf-setup` — мастер установки предложит скачать цепочку CA и пропишет путь в конфиг. Альтернатива — получить CA у администратора сервера и указать `"caPath": "/path/to/ca.pem"` в конфиге вручную, или положить cert в `NODE_EXTRA_CA_CERTS`.
- **Чего не стоит делать:** `NODE_TLS_REJECT_UNAUTHORIZED=0` отключает проверку TLS для **всего** Node-процесса, включая запросы к LLM-провайдеру и любым другим endpoint'ам. Небезопасно даже для быстрой проверки.

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

### Частые реконнекты

- **Симптом:** `[trueconf] Connection closed, scheduling reconnect` повторяется в логах.
- **Причина:** Обрыв WebSocket-соединения на уровне сети. Heartbeat работает как ping/pong с 20-секундным интервалом — если два подряд pong'а не приходят в течение 20 секунд, соединение считается мёртвым и плагин переподключается. 
- **Решение:** Проверьте стабильность сети до TrueConf Server, traceroute, MTU, корпоративный прокси/VPN между клиентом и сервером. Если между плагином и сервером есть reverse-proxy (nginx, haproxy) — убедитесь что таймауты WebSocket idle-соединения там достаточно большие.


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
