# Changelog

## [1.2.5] - 2026-05-01

### Added
- At-least-once outbound delivery via in-memory `OutboundQueue`. Outbound requests (`sendMessage`, `sendFile`, `uploadFile`, `createP2PChat`) survive arbitrary-length WS reconnect windows by parking on transport errors and draining on each successful auth. Closes failure-mode classes (i)/(iii)/(v)/(vi)/(vii) from item 49.
- `LifecycleOptions.onTerminalFailure` callback fires from `lifecycle.shutdown()` and after `DNS_MAX_RETRIES` exhaustion. Wired to `outboundQueue.failAll` in `channel.ts` so terminal failures reject pending outbound with explicit cause.
- Outbound lifecycle instrumentation (`submit` / `wait_auth` / `wire_send` / `ack`) correlated by `qid` for failure-mode diagnosis (L1c). Each outbound request emits four `.info` log lines threading a single id from `OutboundQueue.submit` through `WsClient.sendRequest` and `sendRequestInternal`. Direct ws-client callers (`subscribeFileProgress`) skip the lifecycle log via the optional `traceId` parameter.

### Fixed
- Reconnect-time WS-handshake and auth-response failures (e.g. `ECONNREFUSED`, `Server sent no subprotocol`, `Auth failed: errorCode N`) now park outbound items instead of rejecting them. `lifecycle.start` wraps the auth-barrier rejection as parkable so `waitAuthenticated` callers go through the queue's park-and-drain branch; terminal causes (`DNS_MAX_RETRIES`, `shutdown`) keep their non-parkable form so `onTerminalFailure -> failAll` still flushes pending items on give-up.

### Changed
- `outbound.ts` migrated from `wsClient.sendRequest` / `sendRequestWithReconnectRetry` to `outboundQueue.submit` for all 5 outbound sites. Helper signatures (`sendText`, `sendTextToChat`, `createP2PChat`, `resolveDirectChat`, `recreateChat`) cascade `outboundQueue` parameter.

### Removed
- `outbound.ts:sendRequestWithReconnectRetry` and `DISCONNECTED_RETRY_DELAYS_MS` — superseded by `OutboundQueue` (longer parking window, no fixed retry budget).

## 1.2.2

Fixed plugin failing to load against current openclaw versions due to
reliance on a private SDK subpath (`openclaw/plugin-sdk/mattermost`)
for `loadOutboundMediaFromUrl`. Internalized the helper in
`src/load-media.ts` to remove the dependency on non-public openclaw
internals.
