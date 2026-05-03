# Changelog

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
