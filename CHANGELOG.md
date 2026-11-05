# Changelog

## [Unreleased]

### Fixed
- Group turns no longer call SDK functions that OpenClaw retires on 2026-12-31 (`resolveChannelInboundRouteEnvelope`, `resolveInboundSessionEnvelopeContext`). The route comes from `resolveAgentRoute` and the envelope from `formatInboundEnvelope`, both in OpenClaw 2026.8.1 and current releases. ClawHub's validator flagged the old call when 1.3.0 was published. A group message's `Body` envelope no longer carries the "+elapsed since the previous message" suffix; the agent reads `BodyForAgent`, which is unchanged.
- Outbound sends work for accounts whose id has uppercase letters, such as `accounts.Main`. OpenClaw passes the lowercased id (`main`) to `sendText` and `sendMedia`, which looked it up exactly and logged `no connection for account main`, so message-tool sends, queued follow-ups and restart notices through such an account were dropped.
- Group context lines no longer repeat after a failed turn. A turn now takes its lines once OpenClaw records it in the group session (`afterRecord`), where its `BodyForAgent` may already be in the transcript; before, a failure after that point handed the lines back and the next turn carried them a second time. A turn that fails before it is recorded still leaves its lines for the next one.

## [1.3.0] - 2026-11-03

### Added
- Several OpenClaw instances can share one TrueConf bot account. OpenClaw's standard keys decide which groups an instance serves and who may address it there: `groups` (keyed by chatId or `"*"`, with `requireMention`, `enabled`, `allowFrom`, `tools` and `toolsBySender`), `groupPolicy` (`"open"`, the default, `"disabled"` or `"allowlist"`) and `groupAllowFrom`. Without `groups`, every group is served, as before. A message in a group the instance does not serve gets no reply and is not kept; the first one per chat logs `ignoring group chatId=<id> title="<title>": <reason>`, so the chatId can be copied into `groups`. The README explains the setup and warns that every instance receives every message of the account.
- Group context. Unaddressed messages in a served group stay in memory and go to the next addressed turn in `BodyForAgent`, under OpenClaw's history markers, so they land in the group session's transcript. `historyLimit`, then `messages.groupChat.historyLimit`, then 50 bounds them per chat; `0` turns this off. Files, forwards, locations and surveys are kept as placeholder text without a download. Lines that arrive while a turn runs wait for the next turn. A restart loses lines no turn has taken.
- Group sessions take the TrueConf chat title as their name (`GroupSubject`), fall back to `Group <chatId>` and follow renames.
- Group speakers get their TrueConf display name from `getUserDisplayName`, cached for an hour. A failure, an empty name or a 3 s timeout falls back to the user ID for five minutes.

### Fixed
- Each group chat gets its own OpenClaw session, `agent:<agentId>:trueconf:group:<chatId>`, with chat type `group`. Before, group messages were dispatched as direct messages, so every group and every DM shared the agent's main session, and `session.groupScope` and group bindings did not apply.
- Group turns name the group, `trueconf:group:<chatId>`, as `From`, `To` and `OriginatingTo` instead of the sender and the bot. Message-tool sends without a target, queued follow-ups and restart notices now reach the group, and outbound accepts `trueconf:group:<chatId>` and `group:<chatId>` targets.
- Group turns report whether the bot was addressed (an @-mention, a reply to the bot or a nickname) instead of always claiming a mention. Always-respond chats pass `GroupRequireMention: false`.

### Changed
- **Behavior change:** a group's history no longer mixes with DMs and other groups. Earlier group turns stay in the main session (`agent:main:main` for the default agent).
- **Behavior change:** TrueConf groups get OpenClaw's group system prompt, which tells the model to mostly lurk, reply when addressed or useful, and answer `NO_REPLY` to stay silent. In always-respond chats the activation is "always-on", so the model may now stay silent instead of answering every message.
- With `agents.defaults.sandbox.mode: "non-main"`, TrueConf group sessions are non-main sessions and run in the sandbox.
- **Behavior change:** a generic run failure in a group ends silently instead of posting "Something went wrong".
- `messages.groupChat.*` settings apply to TrueConf groups, including `visibleReplies: "message_tool"`.
- The agent's main session watches TrueConf group sessions after their first human turn.
- `session.groupScope: "main"` routes all TrueConf groups back into the agent's main session.
- Two TrueConf accounts in the same group under one agent share that group's session. To separate them, bind each account to its own agent with `bindings` and `match.accountId`.
- **Behavior change:** only DM turns address the bot's own JID, and the bot-JID self-send redirect goes only to the account's last DM peer. A group message no longer becomes its target; a self-send with no DM peer yet is skipped.
- **Behavior change:** a group turn's `BodyForAgent` starts with the speaker, `Name (user@server): text`, because OpenClaw stores `BodyForAgent` as the session's user line. `Body` uses OpenClaw's group envelope with the same speaker. Command turns keep a bare body.
- `groups.<chatId>.requireMention: false` (or `"*"`) makes a group always-on, like `groupAlwaysRespondIn`. The inbound gate and the group system prompt share this rule, and both match chatIds regardless of case, in `groups` and in `groupAlwaysRespondIn`.
- `dmPolicy` is checked as soon as the chat kind is known, before any quote fetch or file request.
- DMs still follow `session.dmScope`; `"per-channel-peer"` gives each TrueConf user a separate session.

## [1.2.16] - 2026-11-02

### Security
- Reply attachments given as `http(s)` URLs are fetched through OpenClaw's SSRF guard (`fetchWithSsrFGuard`). Before, the plugin fetched any URL the agent named, so a prompt could make the bot read a loopback, private-network or cloud-metadata address and post the response to a chat. **Behavior change:** such URLs now fail with `Blocked hostname or private/internal/special-use IP address`; redirects are re-checked and the resolved address is pinned. To send a file from an internal server, save it into an OpenClaw media directory and send it as a local file.
- Only the OpenClaw owner and senders listed in `channels.trueconf.allowFrom` (`"*"` lists everyone) can add or remove bot nicknames. Before, any group member could ask the agent to add a nickname, and the bot would then answer to it in every group of every account. Listing nicknames stays open.

### Fixed
- A `getFileUploadLimits` push that omits `maxSize` or `extensions` no longer removes that limit. Before, a missing field was read as `null` ("limit disabled"), so an empty push dropped the size cap and the extension filter. Only an explicit `null` disables a limit now.
- Nickname changes take a lock file (`trueconf-nicknames.json.lock`) and re-read the list inside it, so two OpenClaw processes adding nicknames at once no longer drop each other's write. When another process holds the lock for 2 seconds, the tool answers that the list is busy.

### Changed
- The README install and setup commands name the exact plugin version, so `openclaw plugins install` and `npx ... trueconf-setup` run the same release. A test keeps the pinned version equal to `package.json`.
- The README describes nickname activation in groups and its global scope, and no longer suggests `TRUECONF_TLS_VERIFY=false` where a MITM is possible: on a self-signed server it points to `TRUECONF_CA_PATH` with the CA from the server admin. `tlsVerify: false` stays available as the last-resort mode it was.
- Packages can be checked with ClawHub's scanners before a release. `npm run scan:clawhub` runs ClawHub's static scan, from ClawHub's own code at a pinned commit, on the working tree or a `.tgz`; its findings match the site. The first run downloads ClawHub and its dependencies (about 1.3 GB) into `node_modules/.cache/clawhub`. The **ClawHub scan** workflow (Actions tab, any branch or a published `version`) runs that scan plus ClawScan's `clawhub` profile, which matches ClawHub's production suite: SkillSpector, ClawScan static, A.I.G (skipped for plugins) and a Codex judge that reads the whole package. ClawScan is built from a pinned `main` commit, which passes partial SkillSpector reports to the judge, and the judge runs on OpenRouter (`gpt-6.1-sol`, secret `OPENROUTER_API_KEY`). The verdict and findings are in the run summary; the full report is attached to the run.
- `clawhub-publish.yml` runs the `clawhub` CLI directly under Node 24 instead of ClawHub's reusable workflow, which runs `package validate` under Bun and now fails.

## [1.2.15] - 2026-11-02

### Security
- OpenClaw control commands (such as `/new` or `/reset`) run only for senders listed in `channels.trueconf.allowFrom` (`"*"` lists everyone), as in OpenClaw's own channels. Before, every recognized command was marked authorized, so anyone who could DM the bot, or mention it in a group, could run one. **Behavior change:** with no `allowFrom`, commands reach OpenClaw unauthorized and are not executed; the log shows `control command from <id> not authorized`.
- Replies attach local files only from OpenClaw's media roots (its tmp, media, canvas and agent workspace directories). Before, automatic reply delivery passed no roots, and with no roots any path the agent named was read and sent to the chat. Local paths are now refused when no roots are given, and both the file and the roots are resolved with `realpath`, so a link inside a root cannot point outside it.

### Fixed
- ClawHub's static scan no longer reports the setup wizard's password fallback (`src/setup-shared.ts`) as a hardcoded secret.

### Changed
- Releases are published to ClawHub as well as npm. After `npm publish`, the release workflow dispatches `clawhub-publish.yml`, which packs the version npm serves and publishes it through ClawHub's official reusable workflow with GitHub OIDC trusted publishing (no stored token). It can also be run by hand from the Actions tab with a `version` and `dry_run`.

## [1.2.14] - 2026-11-02

### Fixed
- Direct messages are dispatched with `dispatchInboundDirectDm` instead of the deprecated `dispatchInboundDirectDmWithRuntime`. OpenClaw retires the old function on 2026-12-31 and removes it in its first January 2027 stable release, which would stop the plugin from loading. The new function takes the same parameters without `runtime` and resolves the route, envelope and turn dispatch inside OpenClaw.

### Changed
- The minimum OpenClaw version is 2026.8.1 (was 2026.5.28): `dispatchInboundDirectDm` is exported from `openclaw/plugin-sdk/channel-inbound` since 2026.8.1. CI tests the locked OpenClaw at that floor. OpenClaw 2026.8.1 itself requires Node 22.22.3+, 24.15.0+ or 25.9.0+.
- The package passes ClawHub validation with no warnings and can be published there. `package.json` declares `openclaw.build.openclawVersion` (the locked OpenClaw it is built against, 2026.8.1), which ClawHub requires; a test keeps it equal to the lockfile.
- `openclaw.plugin.json` uses `name` and `description` instead of `label` and `blurb`, declares the `channels` category, and drops `minOpenClawVersion`. OpenClaw reads none of the removed fields (the channel label and blurb come from `package.json#openclaw.channel`), and the minimum version stays in `openclaw.compat`.
- The package ships `assets/icon.png` (the TrueConf logo, 512×512), which ClawHub shows as the plugin icon.
- Install commands in the README and in the setup wizard's hint use `openclaw plugins install --accept-capabilities`: OpenClaw 2026.10 refuses to install the plugin without capability consent. The README lists the Node.js versions OpenClaw requires and notes that `dmPolicy: "open"` needs `allowFrom: ["*"]` on OpenClaw 2026.10.
- Checked on a live TrueConf server with OpenClaw 2026.10.9: a direct message gets a model reply, and an image reply arrives as a photo with its preview.

## [1.2.13] - 2026-11-02

### Fixed
- The plugin loads on OpenClaw 2026.10. `waitUntilAbort` is imported from `openclaw/plugin-sdk/channel-outbound`: 2026.10 removed `openclaw/plugin-sdk/channel-lifecycle`, and `channel-outbound` has exported the same function since 2026.5.28.
- The plugin no longer fails to load on OpenClaw 2026.9.9 and later with `libvips-cpp.so: cannot open shared object file`. Those releases stage native modules in separate directories, so `sharp` cannot find `libvips`. `sharp` is now imported only when an image preview is built; if it cannot load, the image is sent as a document without a preview, as on any other preview failure.
- The tarball scan finds the OpenClaw scanner in 2026.5 (`scanner-*.js`).

### Changed
- The minimum OpenClaw version is 2026.5.28 (was 2026.3.22) in `package.json` (`openclaw.compat`, `peerDependencies`), `openclaw.plugin.json` and the README. CI tests the locked OpenClaw at that floor.

## [1.2.12] - 2026-09-29

### Fixed
- The plugin type-checks and passes its release scan on OpenClaw 2026.9 (the 2.0 line). `OpenClawPluginApi` is imported from `openclaw/plugin-sdk/core` because the root `openclaw/plugin-sdk` entry was removed in 2026.8, the default export of `index.ts` has an explicit type (declaration emit failed with TS2742 on 2026.9 because the SDK return type names a private chunk), and the tarball scan finds the OpenClaw scanner under its 2026.9 name. No runtime change: 1.2.11 already loads and connects on OpenClaw 2026.9.4.
- `openclaw.plugin.json` reported version 1.2.9, so `openclaw plugins inspect` showed the wrong plugin version. It now matches `package.json`, and a test keeps the two equal.

### Changed
- CI runs typecheck, lint and tests on every pull request and push to `main`, against the locked OpenClaw and against `openclaw@latest`.

## [1.2.11] - 2026-09-16

### Fixed
- Agent replies keep their line breaks and formatting in TrueConf. The outbound path stripped markdown to plain text and sent it with `parseMode: 'html'`, and TrueConf HTML mode collapses raw newlines, so every reply arrived as one run-on paragraph without bold, links, or lists. Text and file captions now pass through a markdown-to-TrueConf-HTML converter: `**bold**` and headings become `<b>`, `*italic*` becomes `<i>`, `~~strike~~` becomes `<s>`, `[text](url)` becomes `<a href>`, lists get `•` bullets, tables become one line per row, and every line break is sent as `<br>`.
- A literal `<` in a reply no longer deletes the rest of the message. The old tag-stripping regex matched from `<` to the end of the text when no `>` followed, so `if x < 5 …` arrived as `if x`. Text is now HTML-escaped, and only `<b>`, `<i>`, `<u>`, `<s>` written by the agent pass through as tags.

### Changed
- Long replies are split on markdown before conversion, so a chunk boundary never cuts through a tag. A chunk whose HTML outgrows the 4096-character limit is split again.
- `sanitizeMarkdown` and `sanitizeMarkdownPreservingParagraphs` are removed; `src/format.ts` exports `markdownToTrueconfHtml` and `renderForSending` instead.

## [1.2.9] - 2026-06-10

### Fixed
- The npx-cache gate and the entries cleanup now recognize **registry** installs on openclaw >= 2026.6.x. `openclaw plugins install <npm-spec>` on those versions stores the package under `<state-dir>/npm/projects/trueconf-community-trueconf-openclaw-channel-<hash>/` (not `extensions/trueconf`, which 1.2.8 checked) and leaves only `plugins.entries.trueconf` in the raw config. In 1.2.8 the documented `openclaw plugins install` -> `npx ... trueconf-setup` order therefore still dead-ended with "plugin is not installed", and a setup run could still delete the live `plugins.entries.trueconf`, silently disabling the plugin.
- Install detection now accepts `plugins.entries.trueconf` itself as evidence (every observed openclaw version writes it on install). A stale entry letting the gate pass is the cheap failure: the load-path registrar refuses npx-cache dirs, so a false pass can no longer poison the config — while a false block dead-ends the documented flow. The stale-entries cleanup keeps its narrower disk-evidence check (it would otherwise be circular) and still removes a leftover entry when no plugin bits exist anywhere.

## [1.2.8] - 2026-06-10

### Fixed
- `trueconf-setup` now fails fast instead of recording a disposable npx cache path (`~/.npm/_npx/<hash>/...`) in `openclaw.json` when the wizard is run via `npx -p` without a prior `openclaw plugins install`. Prevents the channel later failing to load with `unknown channel id: trueconf` once the npx cache is evicted.
- The npx-cache gate detects an installed plugin on openclaw >= 2026.6.x too: those versions keep install records in the plugin index instead of `plugins.installs` inside `openclaw.json`, so the gate now also accepts an `extensions/trueconf` directory next to the config as install evidence. Without this, the documented `openclaw plugins install` -> `npx ... trueconf-setup` order dead-ended with "plugin is not installed" on a machine where it was.
- `trueconf-setup` no longer deletes `plugins.entries.trueconf` when the plugin is installed. On openclaw 2026.6.x that entry is the live enable record — removing it made the gateway silently skip the installed plugin right after a successful setup (8-plugins-instead-of-9 startup, no `[trueconf]` log lines, channel gone). The stale-entry cleanup still runs when no install evidence exists.
- `trueconf-setup` no longer appends a redundant `plugins.load.paths` entry when the plugin is already installed (extensions/install-record discovery already wires loading).

## [1.2.7] - 2026-06-02

### Fixed
- Account startup no longer fails with `OAuth token request failed: fetch failed (UND_ERR_INVALID_ARG: invalid onRequestStart method)` on hosts whose runtime `undici` differs from the one this plugin bundles. The plugin ships its own `undici` and called `fetch`/`request` without an explicit dispatcher, so those calls fell through to the process-global dispatcher. The OpenClaw runtime installs a custom global dispatcher built from *its own* `undici` (stream-timeout / env-proxy wrapping via `setGlobalDispatcher`); dispatching a request handler created by our bundled `undici` through that foreign Agent throws `UND_ERR_INVALID_ARG`. This reproduced on a host running Node 24+ (whose built-in undici is a newer major than the bundled `^7`) with a private-network LLM provider configured — the gateway aborted the channel at `Account default startup failed`. The OAuth token request (`ws-client`), inbound media download (`inbound`), and outbound media fetch (`load-media`) now always dispatch through an `Agent` from the plugin's own `undici`, so they never route through the host's global dispatcher. The outbound file upload (`outbound`) already used the runtime's global `fetch` and was unaffected. Verified red→green against a live gateway on Node 26.

### Changed
- New internal `src/default-dispatcher.ts` exposes a lazily-created, pooled `Agent` (from the plugin's own `undici`) reused as the default dispatcher across the OAuth, inbound-download, and media-fetch paths. The existing `global-fetch-isolation` regression now also covers a broken global dispatcher (not just a broken global `fetch`).

## [1.2.6] - 2026-06-02

### Fixed
- The published npm package now ships compiled JavaScript so it installs into OpenClaw. 1.2.5 (and earlier) shipped only TypeScript source (`main: ./index.ts`, no `dist/`), so `openclaw plugins install @trueconf-community/trueconf-openclaw-channel` failed with `requires compiled runtime output for TypeScript entry ./index.ts` (`TypeScript source fallback is only supported for source checkouts`). Installing from npm now works without a manual source build.

### Changed
- Build pipeline: a `build` step (`tsc` + `tsc-alias` + copy of `src/probe.mjs`) compiles the plugin per-file into `dist/`, runs in CI before publish, and `dist/` is now in the published `files` with `main`/`extensions`/`setupEntry` pointing at it. Per-file output (not a single bundle) preserves the env/network file separation so the OpenClaw install scanner stays green. Also dropped a stale `tsconfig` `include` entry for a non-existent root `setup-entry.ts`.

## [1.2.5] - 2026-06-01

### Added
- Global bot nicknames (#29). The agent can be taught names it answers to in group chats: a group message now activates the bot on @-mention, reply, **or** any configured nickname. Three agent tools — `remember_bot_nickname`, `forget_bot_nickname`, `list_bot_nicknames` — manage a global, disk-backed nickname list that survives Gateway restarts. Tool names are declared in `openclaw.plugin.json` under `contracts.tools` so the gateway registers them.
- Quoted-message reply context (#29). When an inbound message quotes/replies to another message, the plugin fetches the quoted message via `getMessageById` and prepends its author and text as context for the agent, so a reply to a quote is understood without the surrounding history.

### Fixed
- Account startup no longer leaks resources (#30). When `lifecycle.start()` throws, the account's undici dispatcher (keep-alive socket pool) and registry entry are now torn down (`shutdownAccountEntry` + `accounts.delete` + `clearAccountChats`) instead of lingering as a zombie that could shadow a later re-add.
- Inbound dispatch no longer produces an unhandled promise rejection (#30). A throwing async `onInboundMessage` handler is now caught and logged, matching the existing push-listener guard.
- `forget_bot_nickname` reports the truth when the on-disk write fails (#30). `NicknameStore.remove()` returns a discriminated result (`removed` / `not_found` / `persist_failed`) instead of always claiming success, so a nickname can no longer silently reappear after a restart.
- The nickname store reloads from disk when the file changes (#29), so a nickname registered through a tool is seen by the in-process activation gate without a Gateway restart.

### Changed
- The two markdown sanitizers now share a single `sanitizeMarkdownCore` helper (#30); the differing blank-line collapse step is injected. Output is unchanged.

### Removed
- Dead code (#30): `buildAck`, `IdCounter.current()`, `RequestMatcher.size`, the write-only `pluginRuntimeStore`, and the unused probe helpers `decide()` / `categorizeOAuthError()` (production routing already lives in `probeTls` / `validateOAuthCredentials`).

## [1.2.4] - 2026-05-03

### Added
- Six ENV-tunable knobs for corporate-NAT and slow-network operators (read once at module load — change requires Gateway restart):
  - `TRUECONF_HEARTBEAT_INTERVAL_MS` (default 30000) and `TRUECONF_HEARTBEAT_PONG_TIMEOUT_MS` (default 10000) — operators behind sub-30s idle-timeout NATs can lower the ping cadence without forking.
  - `TRUECONF_OAUTH_TIMEOUT_MS` (default 15000) — `AbortSignal.timeout` cap on the OAuth POST so a hung reverse-proxy cannot pin the lifecycle indefinitely.
  - `TRUECONF_WS_HANDSHAKE_TIMEOUT_MS` (default 20000) — wall-clock cap from `new WebSocket(...)` to the first `'open'` event; on timeout, `ws.terminate()` releases the socket and the existing reconnect loop runs.
  - `TRUECONF_DNS_FAIL_LIMIT` (default 5) and `TRUECONF_OAUTH_FAIL_LIMIT` (default 3) — bound the cumulative DNS retry count and the consecutive OAuth 401/403 count before the lifecycle gives up.
- OAuth 401/403 terminal lifecycle path. After `TRUECONF_OAUTH_FAIL_LIMIT` consecutive 401 or 403 responses, the lifecycle emits `onTerminalFailure({ kind: 'auth_exhausted', retries: N, cause: NetworkError })`, logs `[trueconf] OAuth authentication failed N times; check bot credentials (username/password) on TrueConf Server. Giving up.`, rejects the auth barrier, and stops scheduling reconnects. Recovery is restart-only in v1.2.4. `OAUTH_TERMINAL_CODE = 'OAUTH_GIVEUP'` and `isAuthTerminalCode(401|403)` exported from `types.ts`.
- At-least-once outbound delivery via in-memory `OutboundQueue`. Outbound requests (`sendMessage`, `sendFile`, `uploadFile`, `createP2PChat`) survive arbitrary-length WS reconnect windows by parking on transport errors and draining on each successful auth. Closes failure-mode classes (i)/(iii)/(v)/(vi)/(vii) from item 49.
- `LifecycleOptions.onTerminalFailure` callback fires from `lifecycle.shutdown()`, after DNS retry exhaustion (`kind: 'dns_exhausted'`), and after OAuth 401/403 exhaustion (`kind: 'auth_exhausted'`). Wired to `outboundQueue.failAll` in `channel.ts` so terminal failures reject pending outbound with explicit cause; the discriminated-union design keeps this wiring byte-identical across new variants.
- Outbound lifecycle instrumentation (`submit` / `wait_auth` / `wire_send` / `ack`) correlated by `qid` for failure-mode diagnosis (L1c). Each outbound request emits four `.info` log lines threading a single id from `OutboundQueue.submit` through `WsClient.sendRequest` and `sendRequestInternal`. Direct ws-client callers (`subscribeFileProgress`) skip the lifecycle log via the optional `traceId` parameter.

### Fixed
- Handshake-timer scope was previously bleeding into the auth round-trip — a slow auth response could trigger `WS_HANDSHAKE_TIMEOUT` after the upgrade had already completed. Timer now clears on `ws.on('open')` per the documented handshake-only contract.
- Synchronous re-entry guard on `ConnectionLifecycle.start()` via a `startInFlight` flag prevents the boot path from racing the close-handler-driven `scheduleReconnect()` when a handshake-timeout `ws.terminate()` re-enters `handleClose` while the bootstrap caller is still receiving the rejection.
- WS error metadata extraction no longer produces the literal string `'undefined'` for `code`/`syscall`/`hostname` when the property exists but is undefined — switched to `=== undefined` guards matching the existing `extractFetchCauseMeta` idiom.
- `acquireToken` non-ok response branch now throws `NetworkError(phase='oauth', code=String(status))` instead of generic `Error`, so the new `isAuthTerminalError` classifier in `scheduleReconnect` can distinguish 401/403 (terminal) from 500/502 (transient).
- Reconnect-time WS-handshake and auth-response failures (e.g. `ECONNREFUSED`, `Server sent no subprotocol`, `Auth failed: errorCode N`) now park outbound items instead of rejecting them. `lifecycle.start` wraps the auth-barrier rejection as parkable so `waitAuthenticated` callers go through the queue's park-and-drain branch; terminal causes (DNS exhaustion, OAuth 401/403 exhaustion, shutdown) keep their non-parkable form so `onTerminalFailure -> failAll` still flushes pending items on give-up.

### Changed
- `DNS_MAX_RETRIES` static class constant hoisted to module-level `DNS_FAIL_LIMIT` sourced via the same `readEnvMs` helper as the timing constants. Behaviour unchanged at the default (5 cumulative DNS-class failures); tunable via `TRUECONF_DNS_FAIL_LIMIT`.
- DNS giveup log message phrasing aligned with the post-increment counter — `gave up after N attempts` (was `N retries`, which was off-by-one against the configured limit).
- `outbound.ts` migrated from `wsClient.sendRequest` / `sendRequestWithReconnectRetry` to `outboundQueue.submit` for all 5 outbound sites. Helper signatures (`sendText`, `sendTextToChat`, `createP2PChat`, `resolveDirectChat`, `recreateChat`) cascade `outboundQueue` parameter.

### Removed
- `outbound.ts:sendRequestWithReconnectRetry` and `DISCONNECTED_RETRY_DELAYS_MS` — superseded by `OutboundQueue` (longer parking window, no fixed retry budget).

## 1.2.2

Fixed plugin failing to load against current openclaw versions due to
reliance on a private SDK subpath (`openclaw/plugin-sdk/mattermost`)
for `loadOutboundMediaFromUrl`. Internalized the helper in
`src/load-media.ts` to remove the dependency on non-public openclaw
internals.
