
<p align="center">
  <img src="assets/cover.png" alt="TrueConf-OpenClaw-Channel" width="800" height="auto">
</p>

<h1 align="center">Канал OpenClaw для TrueConf Server</h1>

<p align="center">Подключите <a href="https://openclaw.ai/">OpenClaw</a> к корпоративному <a href="https://trueconf.ru/products/tcsf/besplatniy-server-videoconferenciy.html">мессенджеру Труконф</a>. </p>

<p align="center">
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

После установки ИИ-агент OpenClaw общается с пользователями через TrueConf — сообщения, отправленные боту, передаются ИИ-агенту, а ответы приходят обратно в чат.

```
[TrueConf клиент]  ->  [TrueConf Server]  ->  [OpenClaw + плагин]  ->  [LLM]
    пишешь              Chatbot Connector       получает сообщение      генерирует
   сообщение             передаёт в LLM           ответ
```

## Возможности агента

- **Работа в личных чатах** — отвечает в персональном чате всегда на любое сообщение.
- **Работа в групповых чатах** — отвечает в группе только когда его `@`-упомянули или сделали `reply` на его сообщение (см. раздел [Групповые чаты](#групповые-чаты))

## Требования

- **OpenClaw** >= 2026.3.22
- **TrueConf Server** >= 5.5.3
- **Учётная запись бота** на TrueConf Server (логин и пароль)

## Установка

### Из npm (рекомендуется)

```bash
openclaw plugins install @trueconf-community/trueconf-openclaw-channel
npx -y -p @trueconf-community/trueconf-openclaw-channel trueconf-setup
openclaw gateway
```

`trueconf-setup` — мастер установки плагина: спрашивает URL сервера, логин и пароль бота, проверяет TLS и OAuth, записывает результат в `~/.openclaw/openclaw.json`.

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
export TRUECONF_USERNAME=bot_user              # только логин (TrueConf ID) учетной записи, без @server_name
export TRUECONF_PASSWORD=secret
export TRUECONF_USE_TLS=true                   # опционально; по умолчанию — auto-detect
export TRUECONF_PORT=443                       # опционально
export TRUECONF_ACCEPT_UNTRUSTED_CA=true       # опционально; обязательно для самоподписанных сертификатов

openclaw plugins install @trueconf-community/trueconf-openclaw-channel
npx -y -p @trueconf-community/trueconf-openclaw-channel trueconf-setup
openclaw gateway
```

### Проверка установки

В логах должно появиться:

```
[trueconf] Starting 1 account(s)
[trueconf] Connected and authenticated
```

Откройте клиентское приложение Труконф, найдите бота в контактах и напишите ему сообщение.

## Настройка

### Авторизация для одного бота

```json
{
  "channels": {
    "trueconf": {
      "serverUrl": "trueconf.example.com",
      "username": "bot_user",
      "password": "bot_password",
      "useTls": true
    }
  }
}
```

### Авторизация для нескольких ботов

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
          "useTls": false
        }
      },
      "dmPolicy": "allowlist",
      "allowFrom": ["user1@trueconf.example.com", "user2@trueconf.example.com"]
    }
  }
}
```

### Описание полей

| Поле | Тип | Обязательное | По умолчанию | Описание |
|------|-----|--------------|--------------|----------|
| `serverUrl` | string | Да | -- | Адрес TrueConf Server (например, `10.0.0.1` или `trueconf.example.com`) |
| `username` | string | Да | -- | Имя учётной записи бота на сервере (например, `bot_user`) — без `@сервер`, который указан отдельно в `serverUrl` |
| `password` | string | Да | -- | Пароль бота |
| `useTls` | boolean | Да | -- | Режим подключения (см. раздел TLS) |
| `enabled` | boolean | Нет | `true` | Включить или отключить аккаунт |
| `dmPolicy` | string | Нет | `"open"` | Политика доступа: `open`, `pairing`, `allowlist`, `closed`, `disabled` |
| `allowFrom` | string[] | Нет | -- | Список пользователей при `dmPolicy: "allowlist"` |

## Групповые чаты

Плагин поддерживает работу бота в групповых чатах TrueConf. В отличие от личных диалогов, где бот отвечает на каждое сообщение, **в группе бот реагирует только на явное обращение**:

- **@-mention** — кликните `@` в клиенте TrueConf и выберите бота из списка. Клиент вставит ссылку `<a href="trueconf:<bot-userId>">` в html-сообщение, плагин её распознает и активирует ответ.
- **Reply на сообщение бота** — нажмите «Ответить» на одно из последних сообщений бота. Текст ответа может быть любым, mention не нужен. Буфер: 50 последних сообщений бота на чат.

Сообщения без mention и без reply бот видит, но в чат не пишет — тихо игнорирует.

**Технические детали:**

- Тип чата определяется через `getChatByID` при первом сообщении в новый чат и кешируется до перезапуска gateway. Один лишний WS-запрос на новый чат.
- Каждая группа = одна общая LLM-сессия. История разговора у бота общая на всю группу, не персональная на участника. `senderId` каждого сообщения сохраняется, чтобы LLM знал, кто пишет.
- Параметр `dmPolicy` действует только в личных диалогах. В группах фильтрация — только через mention/reply.
- Каналы TrueConf (`chatType=6`) игнорируются — бот не реагирует на сообщения в них.

**Чтобы добавить бота в группу:** в клиенте TrueConf создайте/откройте групповой чат, добавьте учётную запись бота как участника. Никакой отдельной настройки в `openclaw.json` для групп не нужно — поддержка включена для всех аккаунтов автоматически.

## Медиа-файлы и лимиты

Плагин принимает и отправляет файлы через TrueConf: изображения, аудио, видео и документы. Поведение при получении и отправке файлов настраивается через `openclaw.json` и, при необходимости, ограничивается лимитом размера.

### Лимит размера файла

Поле `maxFileSize` задаёт максимальный размер одного файла в байтах. Действует одинаково для входящих (от пользователя к боту) и исходящих (от бота к пользователю) файлов. По умолчанию — 52 428 800 байт (50 МБ).

**Один бот:**

```json
{
  "channels": {
    "trueconf": {
      "serverUrl": "trueconf.example.com",
      "username": "bot_user",
      "password": "bot_password",
      "useTls": true,
      "maxFileSize": 52428800
    }
  }
}
```

**Несколько ботов:**

```json
{
  "channels": {
    "trueconf": {
      "accounts": {
        "support-bot": {
          "serverUrl": "support.example.com",
          "username": "support",
          "password": "***",
          "useTls": true,
          "maxFileSize": 10485760
        }
      }
    }
  }
}
```

#### Описание поля maxFileSize

| Поле | Тип | Обязательное | По умолчанию | Описание |
|------|-----|--------------|--------------|----------|
| `maxFileSize` | number (байты) | Нет | `52428800` (50 МБ) | Максимальный размер одного файла в байтах. Применяется к входящим и исходящим файлам. Допустимый диапазон: от 1 байта до 2 ГБ. При значении вне диапазона (отрицательное, ноль, нечисловое, Infinity, больше 2 ГБ) плагин пишет `[trueconf] Invalid maxFileSize: ...` в лог и использует значение по умолчанию — работа плагина не прерывается. |

### Классификация медиа-типов

Плагин определяет тип входящего файла по MIME-типу, переданному TrueConf, и использует его для префикса в `rawBody`. Таксономия OpenClaw SDK:

| Тип | MIME-префикс | Пример | Префикс в rawBody |
|-----|--------------|--------|-------------------|
| `image` | `image/*` | `image/jpeg`, `image/png`, `image/webp` | `[Image: photo.jpg]` |
| `audio` | `audio/*` | `audio/ogg`, `audio/mpeg`, `audio/wav` | `[Audio: voice.ogg]` |
| `video` | `video/*` | `video/mp4`, `video/webm` | `[Video: clip.mp4]` |
| `document` | `application/*`, `text/*`, `application/pdf` | `application/pdf`, `text/plain`, `application/vnd.sqlite3` | `[Document: report.pdf]` |

Файлы с неизвестным или пустым MIME-типом классифицируются как `document`. Отказов по MIME нет: плагин никогда не отклоняет файл на основе типа, только на основе размера.

### Сообщения об ошибках

Если файл превышает лимит, недоступен, не успевает загрузиться или отправиться, плагин отвечает пользователю коротким техническим сообщением на русском языке:

| Ситуация | Сообщение пользователю |
|----------|------------------------|
| Файл больше лимита (входящий или исходящий) | `Файл слишком большой (лимит: 50 МБ, ваш файл: 75 МБ).` (значения подставляются динамически из `maxFileSize` и фактического размера) |
| Сервер не отдал файл за 60 секунд | `Файл не успел загрузиться за 60 секунд. Попробуйте ещё раз.` |
| Сервер сообщил, что файла нет | `Файл недоступен на сервере — возможно, он был удалён. Отправьте ещё раз.` |
| Не удалось скачать файл | `Не удалось скачать файл — попробуйте ещё раз.` |
| Исходящий файл не найден локально | `Не удалось найти файл для отправки.` |
| Не удалось загрузить файл на сервер | `Не удалось загрузить файл — попробуйте ещё раз.` |
| Не удалось отправить файл адресату | `Не удалось отправить файл — попробуйте ещё раз.` |
| Сетевой разрыв при отправке | `Соединение прервалось — попробуйте ещё раз.` |
| Неизвестная ошибка | `Не удалось обработать файл — попробуйте ещё раз.` |

Все сообщения — короткие декларативные предложения, без извинений и эмодзи.

## Проверка работы службы TrueConf Bridge (Chatbot Connector)

Перед настройкой плагина убедитесь, что служба TrueConf Bridge работает. Отправьте тестовый запрос на получение JWT-токена:

```bash
curl -sk -X POST https://<адрес-сервера>/bridge/api/client/v1/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"chat_bot","grant_type":"password","username":"<TrueConf ID>","password":"<пароль>"}'
```

Если TrueConf Bridge работает, вы получите `access_token`. Если ошибка `Invalid username or password` — проверьте учётные данные. Если соединение отклонено — убедитесь, что служба TrueConf Bridge запущена.

## Устранение неполадок

### `fetch failed` при запуске

- **Причина:** Сертификат TrueConf Server не от публичного CA (самоподписанный или от корпоративного CA), Node.js ему не доверяет.
- **Решение:** Перезапустите `trueconf-setup` — мастер установки предложит скачать цепочку CA и пропишет путь в конфиг. Для быстрой проверки подойдёт `NODE_TLS_REJECT_UNAUTHORIZED=0`, но в продакшене — не использовать.

### `blocked URL fetch ... resolves to private/internal/special-use IP address`

- **Причина:** Корпоративный прокси или VPN перенаправляет запросы к LLM-провайдеру (например, api.openai.com) на внутренний адрес.
- **Решение:** Настройте прокси (`HTTPS_PROXY`) или используйте локальную модель через Ollama.

### `Missing API key for provider "openai"`

- **Причина:** Не настроен LLM-провайдер.
- **Решение:** Запустите `openclaw configure` и выберите провайдера (OpenAI, Ollama и т.д.).

### Неверные учётные данные

- **Симптом:** `OAuth token acquisition failed (401): invalid_grant` в логах.
- **Причина:** Неверный `username` или `password` в конфиге.
- **Решение:** Проверьте, что `username` — это только имя учётки (`bot_user`), без `@сервер.trueconf.name`; адрес сервера указывается отдельно в `serverUrl`. Убедитесь, что учётная запись активна в панели администратора TrueConf Server.

### Несовпадение TLS

- **Симптом:** `WebSocket error: connect ECONNREFUSED` сразу после запуска.
- **Причина:** `useTls` не соответствует конфигурации сервера.
- **Решение:** Если сервер использует самоподписанный сертификат — `useTls: false`, иначе `useTls: true`.

### Бот подключается, но не отвечает

- **Симптом:** В логах `Connected and authenticated`, но ответов нет.
- **Возможные причины:**
  1. Вы пишете боту из-под того же аккаунта — нужно писать от **другого** пользователя.
  2. Сообщение в групповом чате без @-mention и без reply на бота — в группе нужно явно обратиться (см. раздел [Групповые чаты](#групповые-чаты)). В логе будет строка `group <chatId>: no mention/reply, dropping`.
  3. LLM-провайдер не настроен — запустите `openclaw configure`.
  4. LLM-провайдер недоступен из сети — проверьте доступ или используйте Ollama.

### Частые реконнекты

- **Симптом:** `Connection closed, scheduling reconnect` повторяется в логах.
- **Причина:** Heartbeat таймаут (60 секунд). Если LLM отвечает дольше — соединение считается мёртвым.
- **Решение:** Используйте более быструю модель или увеличьте `HEARTBEAT_INTERVAL_MS` в `src/ws-client.ts`.

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