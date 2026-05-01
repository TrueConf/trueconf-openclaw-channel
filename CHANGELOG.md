# Changelog

## [1.2.5] - 2026-05-01

### Added
- At-least-once outbound delivery via in-memory `OutboundQueue`. Outbound requests (`sendMessage`, `sendFile`, `uploadFile`, `createP2PChat`) survive arbitrary-length WS reconnect windows by parking on transport errors and draining on each successful auth. Closes failure-mode classes (i)/(iii)/(v)/(vi)/(vii) from item 49.
- `LifecycleOptions.onTerminalFailure` callback fires from `lifecycle.shutdown()` and after `DNS_MAX_RETRIES` exhaustion. Wired to `outboundQueue.failAll` in `channel.ts` so terminal failures reject pending outbound with explicit cause.

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
