<p align="center">
  <img src="assets/cover.png" alt="TrueConf-OpenClaw-Channel" width="800" height="auto">
</p>

<h1 align="center">OpenClaw Channel for TrueConf Server</h1>

<p align="center">Connect <a href="https://openclaw.ai/">OpenClaw</a> to the corporate <a href="https://trueconf.com/products/tcsf/trueconf-server-free.html">TrueConf Server</a> messenger. </p>

<p align="center">
    </a>
    <a href="https://t.me/trueconf_chat" target="_blank">
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

After installation, the OpenClaw AI agent communicates with users via TrueConf — messages sent to the bot are forwarded to the AI agent, and responses are delivered back to the chat.

```
[TrueConf client]  ->  [TrueConf Server]  ->  [OpenClaw + plugin]  ->  [LLM]
    you type             Chatbot Connector      receives message       generates response
   a message              forwards to LLM
```

## Agent Capabilities

* **Direct messages** — always responds to any message in a one-on-one chat.
* **Group chats** — responds only when explicitly addressed via an `@` mention or a reply to its message (see [Group Chats](#group-chats)).

## Requirements

* **OpenClaw** >= 2026.3.22
* **TrueConf Server** >= 5.5.3
* **Bot account** on TrueConf Server (username and password)

## Installation

### From npm (recommended)

```bash
openclaw plugins install @trueconf-community/trueconf-openclaw-channel
npx -y -p @trueconf-community/trueconf-openclaw-channel trueconf-setup
openclaw gateway
```

`trueconf-setup` is the plugin setup wizard: it prompts for the server URL, bot credentials, verifies TLS and OAuth, and writes the configuration to `~/.openclaw/openclaw.json`.

### From source code

```bash
git clone https://github.com/TrueConf/trueconf-openclaw-channel.git
cd trueconf-openclaw-channel
npm install
openclaw plugins install -l .
npm run setup
openclaw gateway
```

### Docker / Ansible / CI

Set environment variables before running `trueconf-setup` — the wizard will detect them and skip all prompts:

```bash
export TRUECONF_SERVER_URL=tc.example.com
export TRUECONF_USERNAME=bot_user              # username only (TrueConf ID), without @server_name
export TRUECONF_PASSWORD=secret
export TRUECONF_USE_TLS=true                   # optional; default is auto-detect
export TRUECONF_PORT=443                       # optional
export TRUECONF_ACCEPT_UNTRUSTED_CA=true       # optional; required for self-signed certificates

openclaw plugins install @trueconf-community/trueconf-openclaw-channel
npx -y -p @trueconf-community/trueconf-openclaw-channel trueconf-setup
openclaw gateway
```

### Installation Check

The logs should contain:

```
[trueconf] Starting 1 account(s)
[trueconf] Connected and authenticated
```

Open the TrueConf client, find the bot in contacts, and send it a message.

## Configuration

### Single bot authorization

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

### Multiple bot authorization

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

### Field Description

| Field       | Type     | Required | Default  | Description                                                                                               |
| ----------- | -------- | -------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `serverUrl` | string   | Yes      | --       | TrueConf Server address (e.g., `10.0.0.1` or `trueconf.example.com`)                                      |
| `username`  | string   | Yes      | --       | Bot account username (e.g., `bot_user`) — without `@server`, which is specified separately in `serverUrl` |
| `password`  | string   | Yes      | --       | Bot password                                                                                              |
| `useTls`    | boolean  | Yes      | --       | Connection mode (see TLS section)                                                                         |
| `enabled`   | boolean  | No       | `true`   | Enable or disable the account                                                                             |
| `dmPolicy`  | string   | No       | `"open"` | Access policy: `open`, `pairing`, `allowlist`, `closed`, `disabled`                                       |
| `allowFrom` | string[] | No       | --       | List of allowed users when `dmPolicy: "allowlist"`                                                        |

## Group Chats

The plugin supports bot interaction in TrueConf group chats. Unlike direct messages, where the bot replies to every message, **in group chats the bot only responds when explicitly addressed**:

* **@ mention** — type `@` in the TrueConf client and select the bot. The client inserts a link `<a href="trueconf:<bot-userId>">` into the HTML message, which the plugin detects and triggers a response.
* **Reply to the bot’s message** — click “Reply” on one of the bot’s recent messages. The reply text can be anything; no mention is required. Buffer: last 50 bot messages per chat.

Messages without a mention or reply are visible to the bot but ignored silently.

**Technical details:**

* Chat type is determined via `getChatByID` on the first message in a new chat and cached until the gateway restarts. One extra WS request per new chat.
* Each group = one shared LLM session. Conversation history is shared across the group, not per user. Each message’s `senderId` is preserved so the LLM knows who is speaking.
* `dmPolicy` applies only to direct messages. In groups, filtering is based solely on mention/reply.
* TrueConf channels (`chatType=6`) are ignored — the bot does not respond in them.

**To add the bot to a group:** create or open a group chat in the TrueConf client and add the bot account as a participant. No additional configuration in `openclaw.json` is required — group support is enabled automatically.

## Media Files and Limits

The plugin can receive and send files via TrueConf: images, audio, video, and documents. Behavior is configured via `openclaw.json` and can be restricted by file size limits.

### File Size Limit

The `maxFileSize` field sets the maximum size of a single file in bytes. It applies to both incoming and outgoing files. Default — 52,428,800 bytes (50 MB).

**Single bot:**

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

**Multiple bots:**

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

#### maxFileSize Field Description

| Field         | Type           | Required | Default            | Description                                                                                                                                                                                                                                                                                                 |
| ------------- | -------------- | -------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxFileSize` | number (bytes) | No       | `52428800` (50 MB) | Maximum size of a single file in bytes. Applies to incoming and outgoing files. Allowed range: 1 byte to 2 GB. If the value is invalid (negative, zero, non-numeric, Infinity, or >2 GB), the plugin logs `[trueconf] Invalid maxFileSize: ...` and falls back to the default — plugin operation continues. |

### Media Type Classification

The plugin determines the file type based on the MIME type provided by TrueConf and uses it as a prefix in `rawBody`. OpenClaw SDK taxonomy:

| Type       | MIME prefix                                  | Example                                                    | Prefix in rawBody        |
| ---------- | -------------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| `image`    | `image/*`                                    | `image/jpeg`, `image/png`, `image/webp`                    | `[Image: photo.jpg]`     |
| `audio`    | `audio/*`                                    | `audio/ogg`, `audio/mpeg`, `audio/wav`                     | `[Audio: voice.ogg]`     |
| `video`    | `video/*`                                    | `video/mp4`, `video/webm`                                  | `[Video: clip.mp4]`      |
| `document` | `application/*`, `text/*`, `application/pdf` | `application/pdf`, `text/plain`, `application/vnd.sqlite3` | `[Document: report.pdf]` |

Files with unknown or empty MIME types are classified as `document`. Files are never rejected based on type — only based on size.

### Error Messages

If a file exceeds the limit, is unavailable, or fails to upload/download, the plugin returns a short technical message:

| Situation                | Message                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| File too large           | `File is too large (limit: 50 MB, your file: 75 MB).`                          |
| Timeout (60s)            | `File did not finish uploading within 60 seconds. Try again.`                  |
| File not found on server | `File is unavailable on the server — it may have been deleted. Please resend.` |
| Download failed          | `Failed to download file — try again.`                                         |
| Outgoing file not found  | `File not found for sending.`                                                  |
| Upload failed            | `Failed to upload file — try again.`                                           |
| Send failed              | `Failed to send file — try again.`                                             |
| Network interruption     | `Connection interrupted — try again.`                                          |
| Unknown error            | `Failed to process file — try again.`                                          |

Messages are concise, declarative, and contain no apologies or emojis.

## Checking TrueConf Bridge Service (Chatbot Connector)

Before configuring the plugin, ensure that TrueConf Bridge is running. Send a test request to obtain a JWT token:

```bash
curl -sk -X POST https://<server-address>/bridge/api/client/v1/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"chat_bot","grant_type":"password","username":"<TrueConf ID>","password":"<password>"}'
```

If the service is running, you will receive an `access_token`. If you get `Invalid username or password`, verify credentials. If the connection is refused, ensure the service is running.

## Troubleshooting

### `fetch failed` on startup

* **Cause:** Server certificate is not from a public CA.
* **Solution:** Rerun `trueconf-setup` to install the CA chain. Avoid `NODE_TLS_REJECT_UNAUTHORIZED=0` in production.

### `blocked URL fetch ... resolves to private/internal/special-use IP address`

* **Cause:** Proxy/VPN redirects LLM provider traffic.
* **Solution:** Configure `HTTPS_PROXY` or use a local model (e.g., Ollama).

### `Missing API key for provider "openai"`

* **Cause:** LLM provider not configured.
* **Solution:** Run `openclaw configure`.

### Invalid credentials

* **Symptom:** `OAuth token acquisition failed (401): invalid_grant`
* **Solution:** Verify username/password and ensure account is active.

### TLS mismatch

* **Symptom:** `WebSocket error: connect ECONNREFUSED`
* **Solution:** Match `useTls` to server configuration.

### Bot connects but does not respond

* **Possible causes:** same account, missing mention in group, LLM not configured, network issues.

### Frequent reconnects

* **Cause:** Heartbeat timeout (60s).
* **Solution:** Use a faster model or increase `HEARTBEAT_INTERVAL_MS`.

### Logs

All plugin messages are prefixed with `[trueconf]`.

**Linux/macOS:**

```bash
openclaw gateway 2>&1 | grep '\[trueconf\]'
```

**Windows (PowerShell):**

```powershell
openclaw gateway | Select-String '\[trueconf\]'
```

## Testing

```bash
npm test
```
