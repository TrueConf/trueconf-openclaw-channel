# Spec: Change TLS certificate / trust method on every wizard re-run

**Status:** Approved design (brainstorming complete) — ready for plan
**Date:** 2026-06-18
**Branch:** `feat/wizard-change-cert-on-rerun` (off `origin/main`, release 1.2.9 `f176608`)

## 1. Problem

After a successful first install, re-running the TrueConf setup wizard gives the
operator no way to change the pinned CA certificate path or the TLS trust method.
The wizard silently reuses whatever trust config is already stored. To repoint to a
new CA file, switch to/from insecure mode, or return to system trust, the operator
must hand-edit `openclaw.json` (or delete fields and re-run).

Two independent wizard entry points both exhibit this, via different mechanisms:

- **Standalone CLI** (`npx trueconf-setup` / `npm run setup`):
  `bin/trueconf-setup.mjs` → `runSetup` → `runWizardAndFinalize` →
  **`promptProbePreview`** (`src/setup-shared.ts`). On re-run, `useTls` and `port`
  are always present in cfg, so the short-circuit at `setup-shared.ts:161`
  (`if (currentUseTls !== undefined && currentPort !== undefined)`) returns early:
  it skips the probe entirely and reuses `currentCaPath` with **no prompt and no
  re-validation**.
- **OpenClaw onboard / `plugins install` inline wizard**: setup-entry → SDK adapter →
  **`interactiveFinalize`** (`src/channel-setup.ts`). It probes every run, but when
  the stored CA still validates the server, `handleUntrustedCert` silently returns the
  existing anchor at `channel-setup.ts:569`
  (`return { nextCaPath: resolved, nextCaBytes: v.caBytes }`) — no opportunity to change.

### 1.1 Latent bug discovered

In the CLI path, `promptProbePreview` neither receives nor returns `tlsVerify`. On
re-run of an account previously configured **insecure** (`tlsVerify:false`), the
short-circuit returns `tlsVerify: undefined`, and `patchChannelWithFinalValues`
(which strips and re-derives trust fields) drops `tlsVerify:false`. The re-saved
config silently loses insecure mode → the next `openclaw gateway` attempts strict
verification against an untrusted cert and fails. This feature fixes that as a side
effect (the gate threads `currentTlsVerify` through).

## 2. Goals / Non-goals

**Goals**
- On every **interactive** re-run, when an explicit trust config exists (`caPath` set
  OR `tlsVerify:false`), offer the operator a chance to KEEP or CHANGE the trust
  method/cert — in BOTH the CLI and onboard wizards.
- "Change" can repoint the CA file, switch to insecure, or re-detect from the server
  (→ system trust or fresh untrusted flow).
- On KEEP of a pinned CA, re-validate the stored anchor against the live server (catch
  rotation/MITM); on mismatch, route into the existing mismatch recovery; on
  unreachable, keep with a warning (don't block).
- Consolidate the duplicated trust primitives (`resolveAbsPath`,
  `readCaFileInteractive`, insecure-confirm) shared between the two paths into one
  module.
- Fix the insecure-drop latent bug (§1.1).

**Non-goals**
- No change to headless (`runHeadlessFinalize`) or env-override
  (`TRUECONF_CA_PATH` / `TRUECONF_TLS_VERIFY`) precedence — they stay deterministic for
  CI/bootstrap, with no new prompts.
- No change to the FIRST-run trust flow (fresh untrusted cert → use-file / insecure /
  abort).
- No change to the TOCTOU invariant, mismatch/rotation banners, or the
  mutual-exclusion field-clearing rules.
- No new runtime dependency; no version bump in this branch (versioning is done at
  release time).

## 3. UX contract (the decision tree)

**Trigger:** interactive re-run with an existing explicit trust config in
`channels.trueconf` — `caPath` set OR `tlsVerify === false`. Pure system trust
(neither set) does NOT trigger the gate; nothing is pinned to change, and the normal
probe flow is unchanged.

After resolving the server host/port:

**A. Stored pinned CA (`caPath` set):**
1. Read + re-validate the stored CA against the live server.
   - **Valid** → note "Current TLS check: CA file `<path>`" + confirm
     **"Keep the current TLS/certificate setup?"** (default YES).
     - YES → keep (current behavior); proceed to OAuth with the validated bytes.
     - NO → **change menu (C)**.
   - **Mismatch** (stored anchor no longer builds to the server) → existing mismatch
     banner + existing menu (`accept-new` / `use-file` / `abort`).
     *(onboard already does this; CLI gains it.)*
   - **Unreadable** (file missing / permission) → existing missing-file banner +
     existing menu (`re-tofu` / `use-file` / `abort`).
     *(onboard already does this; CLI gains it.)*
   - **Server unreachable during re-validation** → warning note ("Server unreachable —
     keeping stored CA without re-validation (`<error>`)") + keep the stored anchor.
     Do not block. *(onboard currently throws here; changed to lenient — interactive
     only.)*

**B. Currently insecure (`tlsVerify:false`):**
1. Note "TLS verification is disabled (insecure)" + confirm
   **"Keep the current setup?"** (default YES).
   - YES → keep `tlsVerify:false`.
   - NO → **change menu (C)**.

**C. Change menu** (`select`, reached from A-NO or B-NO):
- "Specify a different CA file" → `readCaFileInteractive` (validates against server;
  up to 3 attempts; existing copy).
- "Disable verification (insecure)" → insecure warning + confirm → `tlsVerify:false`.
- "Re-detect from the server (re-probe)" → fresh `probeTls`:
  - server now trusted → system trust (clear caPath, no tlsVerify).
  - server still untrusted → fresh-untrusted sub-flow (use-file / insecure / abort)
    wired to the same shared primitives. (Auto-download/TOFU is intentionally NOT in
    this menu, matching the existing fresh-untrusted menu.)
- "Cancel" → abort (throws, no config change).

**Unchanged:** headless, env override, first-run, `useTls:false`, field
mutual-exclusion clearing.

## 4. Architecture

New module **`src/setup-trust.ts`** — the single home for interactive trust review and
the primitives both wizards share.

Today these are duplicated across the two entry modules:
- `resolveAbsPath` — `channel-setup.ts:310` AND inline in `promptProbePreview`
  (`setup-shared.ts`).
- `readCaFileInteractive` — `channel-setup.ts:366`; `setup-shared.ts` has its own
  inline CA-file read loop (`promptProbePreview` ~lines 209-248).
- insecure warning + confirm — in both.

`setup-trust.ts` exports:
1. `resolveAbsPath(raw: string): string` — moved; both modules import it.
2. `readCaFileInteractive(args): Promise<{ nextCaPath; nextCaBytes }>` — moved from
   `channel-setup.ts` (with its `shortFp` helper); `channel-setup.ts` re-imports.
3. `promptInsecureConfirm(args): Promise<boolean>` — factored from both inline copies
   (renders the `tls.insecure.warning` note + `tls.insecure.confirm`).
4. `reviewExistingTrust(args): Promise<TrustDecision>` — the new gate + change-menu.
   Accepts `alreadyValidated?: { caBytes: ValidatedCaBytes }`: a caller that has
   already validated the stored CA (onboard) passes it and `reviewExistingTrust` skips
   re-validation and goes straight to the gate; a caller that has not (CLI) omits it
   and `reviewExistingTrust` probes + validates internally.

```ts
interface ReviewExistingTrustArgs {
  prompter: WizardPrompter
  probe: ProbeModule            // { probeTls, parseCertFromPem, validateCaAgainstServer, ... }
  host: string
  port: number
  current: { caPath?: string; tlsVerify?: boolean }
  alreadyValidated?: { caBytes: ValidatedCaBytes }
  locale: Locale
}
type TrustDecision = { caPath?: string; caBytes?: ValidatedCaBytes; tlsVerify?: boolean }
// empty object = system trust (caller clears caPath + tlsVerify)
```

Probe functions are passed in (the `ProbeModule` shape) so both callers inject the
same way `setup-shared.ts` already does and `channel-setup.ts` can pass the imported
`probe.mjs` namespace.

### Integration points

**CLI — `promptProbePreview` (`setup-shared.ts`):**
- Add parameter `currentTlsVerify: boolean | undefined`.
- In the short-circuit branch (`currentUseTls !== undefined && currentPort !== undefined`):
  if `currentUseTls !== false` AND an explicit trust config exists (`currentCaPath` set
  OR `currentTlsVerify === false`), call
  `reviewExistingTrust({ current: { caPath: currentCaPath, tlsVerify: currentTlsVerify }, host: serverUrl, port: currentPort, prompter, probe: probeModule, locale })`
  and map its `TrustDecision` into the returned
  `{ useTls: currentUseTls, port: currentPort, caPath, caBytes, tlsVerify }`.
  Otherwise keep the existing reuse return.
- Caller `runWizardAndFinalize` passes `tcFields.tlsVerify` as the new arg.
- `patchChannelWithFinalValues` is unchanged — it already honors the
  `{ caPath, tlsVerify }` mutual exclusion; threading `tlsVerify` through fixes §1.1.

**onboard — `interactiveFinalize` / `handleUntrustedCert` (`channel-setup.ts`):**
- Stored-CA-valid point (`channel-setup.ts:569`): replace the silent
  `return { nextCaPath, nextCaBytes }` with
  `reviewExistingTrust({ current: { caPath: resolved }, alreadyValidated: { caBytes: v.caBytes }, host, port, prompter, probe, locale })`,
  mapping the decision back to `{ nextCaPath, nextCaBytes }` / `{ tlsVerify }`. Keep is
  the default; change opens the menu.
- Insecure re-run: in `interactiveFinalize`, before the probe step (STEP 2), if
  `tc.tlsVerify === false`, route through
  `reviewExistingTrust({ current: { tlsVerify: false }, ... })` for the keep/change
  gate (so onboard insecure matches CLI).
- Unreachable-during-re-validation (`channel-setup.ts:574-578` inside the existing-CA
  branch): change the throw to the lenient keep-with-warning, consistent with §3.A.
- The mismatch / missing-file / fresh-untrusted / rotation / TOCTOU branches in
  `handleUntrustedCert` stay byte-for-byte — they already prompt and are covered by
  tests.

This keeps the blast radius on `interactiveFinalize`/`handleUntrustedCert` to: the
valid-CA gate, the insecure pre-probe gate, and the unreachable-leniency change — all
reusing the shared menu primitives, plus removal of the cross-module duplication.

## 5. i18n additions (en + ru; parity asserted by `tests/unit/channel-setup-i18n.test.ts`)

- `trust.review.keepTitle` — "Current TLS / certificate setup" / "Текущая настройка TLS / сертификата"
- `trust.review.currentCaFile` — "Verification by CA file: {{path}}" / "Проверка по CA-файлу: {{path}}"
- `trust.review.currentInsecure` — "TLS verification is disabled (insecure)" / "Проверка TLS отключена (insecure)"
- `trust.review.keep` — "Keep the current TLS / certificate setup?" / "Оставить текущую настройку TLS / сертификата?"
- `trust.review.changePrompt` — "How should TLS be verified?" / "Как проверять TLS-сертификат?"
- `trust.review.option.reprobe` — "Re-detect from the server (re-probe)" / "Перепроверить с сервера (re-probe)"
- `trust.review.keepUnreachable` — "Server unreachable — keeping the stored CA without re-validation ({{error}})" / "Сервер недоступен — оставляю сохранённый CA без повторной проверки ({{error}})"

Menu reuses existing keys: `select.option.useFile`, `tls.untrusted.choice.insecure`,
`select.option.abort`, and `trust.review.changePrompt` (or `select.whatToDo`).

## 6. Error handling & security invariants (preserved)

- **TOCTOU:** the CA bytes handed to `validateOAuthCredentials` are exactly the bytes
  validated in-process; never re-read from disk between validate and use.
  `reviewExistingTrust` returns `caBytes` (branded `ValidatedCaBytes`), not just a path.
  For the lenient unreachable-keep, the stored bytes are read once and branded via the
  documented operator-trust escape (same pattern as `markValidated`).
- **Mismatch / rotation:** unchanged banners and confirm-before-pin behavior.
- **Mutual exclusion:** the caller's existing field-clearing (`useTls:false` clears
  caPath+tlsVerify; insecure clears caPath; strict clears tlsVerify) is unchanged;
  `reviewExistingTrust` only returns the decision — the caller patches.
- **Abort = no mutation:** every "Cancel" path throws before any cfg write.
- **Unreachable leniency** applies ONLY to interactive keep-of-stored-CA; headless
  still fail-fasts.

## 7. Testing strategy (TDD)

### Changed existing test (the one semantic change)
`tests/integration/setup-wizard-trust.test.ts` →
`'silent happy: stored CA validates server → caPath preserved, no prompts'`
(~lines 166-174): re-run now ALWAYS shows the keep/change gate. Update to drive a
confirm=keep response and assert (a) caPath preserved, (b) the gate note appeared,
(c) `download()` not called, (d) OAuth received the validated bytes. Rename to reflect
"gate shown, keep chosen."

### New tests (both paths; via `makeFakePrompter` + `startTlsFixtureServer`)
Onboard (`interactiveFinalize`):
- valid CA → gate → keep → caPath unchanged, OAuth gets validated bytes.
- valid CA → gate → change → use-file (valid PEM) → new caPath saved, download not called.
- valid CA → gate → change → insecure → tlsVerify:false, caPath cleared, OAuth gets
  tlsVerify:false + no ca.
- valid CA → gate → change → re-probe (server trusted fixture) → system trust
  (caPath cleared).
- insecure account re-run → gate → keep → tlsVerify:false preserved.
- insecure account re-run → gate → change → use-file → caPath set, tlsVerify cleared.
- valid CA → gate → change → cancel → throws, cfg untouched.
- unreachable during re-validation → keep-with-warning note + caPath preserved.
- regression: mismatch / missing / rotation cases unchanged (existing tests pass).

CLI (`promptProbePreview` / `runWizardAndFinalize`, direct or via bin integration):
- re-run with stored valid caPath → gate → keep → return preserves caPath + caBytes.
- re-run with stored caPath → gate → change → use-file → new caPath.
- re-run insecure account → gate → keep → **tlsVerify:false preserved** (regression
  for §1.1 — assert it survives into `patchChannelWithFinalValues` output).
- re-run with stored caPath, server unreachable → keep-with-warning, caPath preserved.

Unit (`setup-trust.ts`):
- `reviewExistingTrust` decision table with a stubbed prompter + probe (alreadyValidated
  vs not; valid / mismatch / unreachable / each menu choice).
- `promptInsecureConfirm`, `resolveAbsPath` moved-coverage.
- i18n parity test auto-covers the new keys.

### Regression net
Full `tests/integration/setup-wizard*.test.ts`, `bin-trueconf-setup.test.ts`,
`tests/unit/channel-setup*.test.ts`, `setup-adapter.test.ts`, `setup-entry-shape.test.ts`
+ `npm run lint` (oxlint) + `npm run typecheck` (tsc). Establish a green baseline
before edits.

## 8. Edge cases & behavior changes (risks)

1. **Behavior change (intended):** onboard "silent happy" re-run now shows a 1-confirm
   gate (the only changed existing test).
2. **Latent fix:** CLI insecure re-run no longer drops `tlsVerify:false`.
3. **Behavior change (intended, interactive only):** onboard
   unreachable-during-re-validation no longer throws — keeps with a warning.
4. **Probe unreachable on re-run** (distinct from re-validation unreachable):
   unchanged. The gate triggers after a reachable probe / when re-validation is
   attempted; a fully-unreachable probe falls through to the existing fallback
   (HTTPS:443) path. Flagged as a possible future enhancement, out of scope here.
5. **System trust (no pinned CA):** no gate — an operator on a publicly-trusted server
   who wants to pin a CA or go insecure is not offered the menu (probe never enters the
   untrusted branch). Documented limitation, out of scope.
6. **`useTls:false` (plain WS):** no trust to review; short-circuit reuse unchanged.

## 9. Out of scope
- Multi-account (`accounts.<id>`) trust review — the wizard operates on the flat/default
  account; multi-account re-run UX is a separate concern.
- Pinning a CA on a system-trusted server (item 5 above).
- Versioning / npm release / user-facing CHANGELOG entry — done at release time.

## 10. Rollout
- Branch `feat/wizard-change-cert-on-rerun` off `origin/main` (1.2.9).
- TDD implementation: green baseline → red tests → implement → verify → multi-agent
  review → fix.
- No version bump; CHANGELOG deferred to release. Spec/plan under `docs/superpowers/`
  are not shipped (outside the npm `files` allowlist).
