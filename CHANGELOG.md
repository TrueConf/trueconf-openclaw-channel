# Changelog

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
