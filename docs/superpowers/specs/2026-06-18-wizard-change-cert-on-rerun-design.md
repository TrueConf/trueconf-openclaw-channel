# Spec: Change TLS certificate / trust method on every wizard re-run

**Status:** Approved design, revised v2 after adversarial agent-review — ready for plan
**Date:** 2026-06-18
**Branch:** `feat/wizard-change-cert-on-rerun` (off `origin/main`, release 1.2.9 `f176608`)
**Revision:** v2 — incorporates 3 spec reviews (security/trust, correctness/arch, test-completeness). See §11 for the finding→resolution map.

## 1. Problem

After a successful first install, re-running the TrueConf setup wizard gives the
operator no way to change the pinned CA certificate path or the TLS trust method.
The wizard silently reuses whatever trust config is already stored. To repoint to a
new CA file, switch to/from insecure mode, or return to system trust, the operator
must hand-edit `openclaw.json`.

Two independent wizard entry points exhibit this, via different mechanisms:

- **Standalone CLI** (`npx trueconf-setup` / `npm run setup`):
  `bin/trueconf-setup.mjs` → `runSetup` → `runWizardAndFinalize` →
  **`promptProbePreview`** (`src/setup-shared.ts`). On re-run, `useTls` and `port`
  are always present in cfg, so the short-circuit at `setup-shared.ts:161`
  (`if (currentUseTls !== undefined && currentPort !== undefined)`) returns early:
  it skips the probe entirely and reuses `currentCaPath` with **no prompt and no
  re-validation** (it only `readFileSync`s the file at `:168-175`; it never calls
  `validateCaAgainstServer`).
- **OpenClaw onboard / `plugins install` inline wizard**: setup-entry → SDK adapter →
  **`interactiveFinalize`** (`src/channel-setup.ts`). It probes every run, but when
  the stored CA still validates the server, `handleUntrustedCert` silently returns the
  existing anchor at `channel-setup.ts:569`
  (`return { nextCaPath: resolved, nextCaBytes: v.caBytes }`) — no opportunity to change.

### 1.1 Latent bug discovered (fixed as a side effect)

In the CLI path, `promptProbePreview` neither receives nor returns `tlsVerify`
(short-circuit returns `tlsVerify: undefined`, `setup-shared.ts:181`). On re-run of an
account configured **insecure** (`tlsVerify:false`), `patchChannelWithFinalValues`
strips the existing `tlsVerify` (`:328`) and only re-adds it when `values.tlsVerify ===
false` (`:339-343`) → insecure mode is silently dropped → the next `openclaw gateway`
does strict verification against an untrusted cert and fails. Threading
`currentTlsVerify` through the gate fixes this. **Note:** the `tcFields` inline object
type at `setup-shared.ts:429-436` lists `serverUrl/username/password/useTls/port/caPath`
but **not** `tlsVerify`; it MUST be widened to `tlsVerify?: boolean` or
`tcFields.tlsVerify` is a TS compile error (breaks `npm run typecheck`).

## 2. Goals / Non-goals

**Goals**
- On every **interactive** re-run, when an explicit trust config exists (`caPath` set
  OR `tlsVerify:false`), offer the operator a KEEP-or-CHANGE gate for the trust
  method/cert — in BOTH the CLI and onboard wizards.
- "Change" can repoint the CA file, switch to insecure, or re-detect from the server
  (→ system trust or fresh untrusted flow).
- On KEEP of a pinned CA, re-validate the stored anchor against the live server (catch
  rotation/MITM); on mismatch, route into the existing mismatch recovery; on
  unreachable, keep with a warning (don't block).
- Consolidate the duplicated trust primitives into one module.
- Fix the insecure-drop latent bug (§1.1).

**Non-goals**
- No change to headless (`runHeadlessFinalize`) or env-override
  (`TRUECONF_CA_PATH` / `TRUECONF_TLS_VERIFY`) precedence — deterministic for
  CI/bootstrap, no new prompts. The env (`TRUECONF_CA_PATH`) STEP-1 branch keeps strict
  precedence over the gate.
- No change to the FIRST-run trust flow (fresh untrusted cert → use-file / insecure /
  abort), nor to the mismatch / missing-file / rotation / TOCTOU branches of
  `handleUntrustedCert`.
- No new runtime dependency; no version bump in this branch.

## 3. UX contract (the decision tree)

**Trigger:** interactive re-run with `useTls !== false` AND an existing explicit trust
config in `channels.trueconf` — `caPath` set OR `tlsVerify === false`. Pure system trust
(neither set) and `useTls:false` do NOT trigger the gate; the existing flow is unchanged.

After resolving the server host/port:

**A. Stored pinned CA (`caPath` set):**
1. Read + re-validate the stored CA against the live server.
   - **Valid** → note "Current TLS check: CA file `<path>`" + confirm
     **"Keep the current TLS/certificate setup?"** (default YES).
     - YES → keep; proceed to OAuth with the validated bytes.
     - NO → **change menu (C)**.
   - **Mismatch** — **(onboard)** existing mismatch banner + existing menu
     (`accept-new` / `use-file` / `abort`), unchanged via `handleUntrustedCert`.
     **(CLI)** warning note (`trust.review.mismatchWarn`) + the change menu (C).
     *Rationale:* CLI recovery uses the change menu rather than porting the
     `accept-new`/TOFU machinery (`buildMismatchBanner`, `downloadAndAudit`) into the
     shared module — that would force a `setup-trust ↔ channel-setup` circular import
     and break the byte-for-byte `handleUntrustedCert` + `channel-setup-banners.test.ts`.
     CLI is thereby slightly more conservative (no auto-download on mismatch).
   - **Unreadable** — **(onboard)** existing missing-file banner + existing menu
     (`re-tofu` / `use-file` / `abort`), unchanged. **(CLI)** warning note
     (`trust.review.fileUnreadable`) + the change menu (C).
   - **Server unreachable during re-validation** → warning note (security-explicit, see
     §5 `trust.review.keepUnreachable`) + keep the stored anchor without re-validation.
     Do not block. *(onboard currently throws at `channel-setup.ts:574-578`; changed to
     lenient — interactive only; headless still throws.)* The kept bytes are NOT branded
     as server-validated — see §6.

**B. Currently insecure (`tlsVerify:false`):**
1. Note "TLS verification is disabled (insecure)" + confirm
   **"Keep the current setup?"** (default YES).
   - YES → keep `tlsVerify:false`; **skip the probe**; proceed to OAuth.
   - NO → **change menu (C)**.

**C. Change menu** (`select`, reached from A-NO or B-NO):
- "Specify a different CA file" → `readCaFileInteractive` (validates against server;
  up to 3 attempts).
- "Disable verification (insecure)" → insecure warning + confirm → `tlsVerify:false`.
- "Re-detect from the server (re-probe)" → fresh `probeTls`:
  - server now trusted → system trust (clear caPath + tlsVerify).
  - server still untrusted → fresh-untrusted sub-flow (use-file / insecure / abort)
    wired to the shared primitives. **No auto-download/TOFU** in this menu (matches the
    existing fresh-untrusted menu's deliberate omission, `channel-setup.ts:608-625`).
- "Cancel" → abort (throws, no config change). Uses `select.option.abortSetup` copy.

**On an empty/unrecognized `select` value** (drained test queue / cancel): the change
menu MUST abort with an explicit error — it must NOT silently fall through to "use a
file" (the current `handleUntrustedCert` fall-through at `:640` is a footgun we do not
replicate; see §7 fake-prompter note).

**Unchanged:** headless, env override, first-run, `useTls:false`, mismatch/missing/
rotation/TOCTOU branches, the caller's field mutual-exclusion clearing (with the
system-trust caPath-clear fix in §4).

## 4. Architecture

New module **`src/setup-trust.ts`** — single home for the interactive trust review and
the primitives both wizards share.

Duplicated today across the two entry modules:
- `resolveAbsPath` — `channel-setup.ts:310` AND inline in `promptProbePreview`
  (`setup-shared.ts:220-221`).
- `readCaFileInteractive` (+ its `shortFp` helper `:359`) — `channel-setup.ts:366`;
  `setup-shared.ts` has its own inline CA-file read loop (`promptProbePreview` ~209-248).
- insecure warning + confirm — in both.

`setup-trust.ts` exports:
1. `resolveAbsPath(raw: string): string` — moved; both modules import it.
2. `readCaFileInteractive(args): Promise<{ nextCaPath; nextCaBytes }>` — moved from
   `channel-setup.ts` (with `shortFp`); `channel-setup.ts` re-imports.
3. `promptInsecureConfirm(args): Promise<boolean>` — factored from both inline copies.
4. `reviewExistingTrust(args): Promise<TrustDecision>` — the gate + change-menu.

```ts
interface ReviewExistingTrustArgs {
  prompter: WizardPrompter
  probe: ProbeModule                 // { probeTls, parseCertFromPem, validateCaAgainstServer, downloadCAChain }
  host: string
  port: number
  current: { caPath?: string; tlsVerify?: boolean }
  alreadyValidated?: { caBytes: ValidatedCaBytes }  // onboard passes pre-validated bytes → skip re-validation
  locale: Locale
}

// Discriminated union — caPath and caBytes are CO-REQUIRED (TOCTOU); the three
// terminal outcomes are explicit so callers map clearFields correctly. Abort throws.
type TrustDecision =
  | { kind: 'pinned'; caPath: string; caBytes: ValidatedCaBytes }
  | { kind: 'insecure' }   // → tlsVerify:false, clear caPath
  | { kind: 'system' }     // → clear caPath AND tlsVerify
```

- Probe fns are injected via `ProbeModule` so the CLI passes its `probeModule` and
  onboard passes the statically-imported `probe.mjs` namespace.
- The lenient unreachable-keep mints its bytes locally via the documented operator-trust
  cast escape (the same `as unknown as ValidatedCaBytes` pattern used at
  `setup-shared.ts:464`), **NOT** by importing `markValidated` from `channel-setup.ts`
  (that would create a `setup-trust → channel-setup → setup-trust` cycle). See §6.

### Integration points

**CLI — `promptProbePreview` (`setup-shared.ts`):**
- Add parameter `currentTlsVerify: boolean | undefined`. Widen the `tcFields` inline
  type (`:429-436`) to include `tlsVerify?: boolean`; `runWizardAndFinalize` passes
  `tcFields.tlsVerify` (`:444`).
- In the short-circuit branch (`currentUseTls !== undefined && currentPort !== undefined`):
  - If `currentUseTls !== false` AND an explicit trust config exists (`currentCaPath` set
    OR `currentTlsVerify === false`): call `reviewExistingTrust({ current: { caPath, tlsVerify }, ... })`
    (omit `alreadyValidated` → it probes + re-validates internally) and map its
    `TrustDecision` into `{ useTls, port, caPath, caBytes, tlsVerify }`.
  - **Else** (no trust config — plain useTls+port pin, or `useTls:false`): keep the
    existing probe-free reuse return. The short-circuit's probe-free contract is thereby
    **narrowed** to "nothing to review," not removed.
- **Consequence (a second changed existing test):** `bin-trueconf-setup.test.ts:762`
  `'skip-probe path preserves existing cfg.caPath into OAuth + saved cfg'` pins
  `{useTls:true, port, caPath}` and asserts `probeTls` is never called (its stub throws
  at `:778` and provides no `validateCaAgainstServer`). With CLI keep now re-validating,
  this test MUST be rewritten to supply `validateCaAgainstServer`/`parseCertFromPem`
  stubs + a reachable fixture + a keep-confirm, and renamed (e.g. "re-validates and keeps
  stored caPath"). This is an intentional behavior change honoring the "re-validate on
  keep" decision; the skip-probe-without-revalidation behavior it encoded is exactly what
  we are replacing.

**onboard — `interactiveFinalize` / `handleUntrustedCert` (`channel-setup.ts`):**
Minimal placement — two gate insertions + one leniency change, leaving the
mismatch/missing/fresh/rotation/TOCTOU branches byte-for-byte:
1. **Insecure pre-probe gate** — as the FIRST sub-branch of `else if (useTls !== false)`
   (`:704`), i.e. only when `!envPath` (env STEP-1 precedence preserved):
   `if (tc.tlsVerify === false) { decision = reviewExistingTrust({ current: { tlsVerify: false }, ... }); map; SKIP the probe/STEP-3 entirely; go to OAuth }`.
   "Keep" sets `tlsVerify=false, useTls=true, port=port??443`. This prevents the
   double-prompt where the probe would re-enter `handleUntrustedCert` and re-ask.
2. **Valid-CA gate** at `channel-setup.ts:569`: replace the silent
   `return { nextCaPath, nextCaBytes }` with
   `reviewExistingTrust({ current: { caPath: resolved }, alreadyValidated: { caBytes: v.caBytes }, ... })`
   (skips re-validation — onboard already validated at `:567`). Map the decision back.
3. **Unreachable leniency** at `channel-setup.ts:574-578` (inside the existing-CA branch):
   change the throw to the lenient keep-with-warning per §3.A.
- **clearFields fix (system trust):** when the trust review yields `kind:'system'` (or
  `kind:'insecure'`) while the prior cfg had a `caPath`, the caller MUST ensure `caPath`
  is cleared. The existing logic (`:788-795`) clears caPath on `useTls:false`/insecure
  but the `else` (strict/system) branch clears only `tlsVerify` → a system-trust
  transition would leave a STALE `caPath`. Add `caPath` to `clearFields` for the
  system-trust outcome. (CLI is unaffected — `patchChannelWithFinalValues` strips the old
  caPath when `values.caPath` is undefined.)

## 5. i18n additions (en + ru)

Per-key `{ en, ru }` structure is enforced at compile time by TypeScript (a missing
sub-key is a type error), and the every-key parity loop lives in
**`tests/unit/i18n.test.ts:17-24`** (`'every key has both en and ru entries'`) — it
auto-covers new keys. *(The earlier draft mis-cited `channel-setup-i18n.test.ts`, which
only spot-checks descriptor strings.)*

- `trust.review.keepTitle` — "Current TLS / certificate setup" / "Текущая настройка TLS / сертификата"
- `trust.review.currentCaFile` — "Verification by CA file: {{path}}" / "Проверка по CA-файлу: {{path}}"
- `trust.review.currentInsecure` — "TLS verification is disabled (insecure)" / "Проверка TLS отключена (insecure)"
- `trust.review.keep` — "Keep the current TLS / certificate setup?" / "Оставить текущую настройку TLS / сертификата?"
- `trust.review.changePrompt` — "How should TLS be verified?" / "Как проверять TLS-сертификат?"
- `trust.review.optionCaFile` — "Specify a different CA file" / "Указать другой CA-файл"
- `trust.review.optionReprobe` — "Re-detect from the server (re-probe)" / "Перепроверить с сервера (re-probe)"
- `trust.review.keepUnreachable` — security-explicit: "Server unreachable — keeping the stored CA WITHOUT re-validation. If this is unexpected it could be a network failure OR an attacker blocking the check; the credential login below still verifies against this CA and will fail closed. ({{error}})" / Russian equivalent naming the MITM possibility.
- `trust.review.mismatchWarn` — "The stored CA file no longer validates this server ({{error}}). The certificate may have rotated, or this could be a MITM — verify with the admin before trusting a new one." / Russian equivalent (CLI mismatch warning before the change menu).
- `trust.review.fileUnreadable` — "Stored CA file is missing or unreadable: {{path}} ({{reason}})." / Russian equivalent (CLI missing-file warning before the change menu).

Menu reuses existing keys where copy fits: `tls.untrusted.choice.insecure` (insecure
option), `select.option.abortSetup` (cancel). The "different CA file" and "re-probe"
options use the new `trust.review.optionCaFile` / `trust.review.optionReprobe`
(intentional copy, distinct from `select.option.useFile` "Specify a new path…" used in
the mismatch recovery menu).

## 6. Error handling & security invariants (preserved)

- **TOCTOU:** the CA bytes handed to `validateOAuthCredentials` are exactly the bytes
  validated in-process; never re-read between validate and use. `TrustDecision`'s
  `pinned` variant carries `caBytes` co-required with `caPath` so a path can never reach
  OAuth without its validated bytes.
- **Lenient unreachable-keep is NOT branded as server-validated.** The stored bytes are
  read once and passed to OAuth via the documented operator-trust cast escape (same as
  `setup-shared.ts:464`), with a comment that they were NOT re-validated this run and
  that **OAuth's `rejectUnauthorized:true` is the sole gate** (OAuth receives
  `ca: <stored bytes>`, `tlsVerify` undefined → strict verify; a tampered/rotated cert
  makes OAuth fail closed with `category:'tls'`). A test asserts: tampered stored file +
  blocked re-validation probe → OAuth `tls` failure, NOT a silent save.
- **Network attacker forcing "unreachable":** a substitution MITM handshake-succeeds →
  classified `untrusted` → mismatch branch (not unreachable), so it cannot reach the
  lenient path. A blackhole/RST attacker can force `unreachable`, but the kept CA still
  gates OAuth (fail-closed). The interactive-vs-headless asymmetry (interactive keeps,
  headless throws) is **deliberate** and documented here; the `keepUnreachable` copy
  names the security implication.
- **Mismatch / rotation / TOCTOU during use-file & re-probe:** unchanged. The change
  menu introduces no `downloadCAChain` call → the rotation-mid-flow window
  (`downloadAndAudit:468-501`) is not newly reachable.
- **Mutual exclusion & system-trust caPath-clear:** per §4 clearFields fix.
- **Abort = no mutation:** every "Cancel"/empty-select path throws before any cfg write.

## 7. Testing strategy (TDD)

### Changed existing tests (TWO, not one)
1. `tests/integration/setup-wizard-trust.test.ts` →
   `'silent happy: stored CA validates server → caPath preserved, no prompts'`
   (~166-174): re-run now shows the keep/change gate. Drive confirm=keep and assert
   (a) caPath preserved, (b) **the gate note appeared** (load-bearing — see fake-prompter
   note), (c) `download()` not called, (d) OAuth got the validated bytes. Rename.
2. `tests/integration/bin-trueconf-setup.test.ts` → `'skip-probe path preserves existing
   cfg.caPath…'` (~762-805): rewrite per §4 (CLI re-validates on keep) — supply
   `validateCaAgainstServer`/`parseCertFromPem` stubs + reachable fixture + keep-confirm;
   rename.

### fake-prompter footgun (must inform every new/edited test)
`tests/smoke/fake-prompter.ts:40` — an empty `confirm` queue returns `true` (keep), it
does NOT throw; an empty `select` queue returns `''`. Therefore:
- The gate-NOTE assertion is the load-bearing check (a default-true confirm would pass a
  test even if the gate never rendered).
- The plan MUST audit every positional `confirmResponses`/`selectResponses` array in the
  onboard + bin suites for one-slot drift introduced by the new confirm, and prefer
  explicit over-long queues so drift surfaces as a wrong value, not a silent default.
- The change menu must abort on empty/unrecognized select (not fall through to use-file).

### New tests
Onboard `interactiveFinalize` (integration via `startTlsFixtureServer` + `makeFakePrompter`):
- valid CA → gate → keep → caPath unchanged, OAuth gets validated bytes, download not called.
- valid CA → gate → change → use-file (valid PEM) → new caPath, download not called.
- valid CA → gate → change → insecure → tlsVerify:false, **caPath cleared**, OAuth gets
  tlsVerify:false + no ca.
- insecure account re-run → gate → keep → tlsVerify:false preserved, **probe not entered**
  (exactly one trust prompt).
- insecure account re-run → gate → change → use-file → caPath set, tlsVerify cleared.
- valid CA → gate → change → cancel → throws, cfg untouched.
- unreachable during re-validation → keep-with-warning note + caPath preserved; plus the
  §6 tampered-file + blocked-probe → OAuth `tls` failure test.
- regression: mismatch / missing / rotation cases unchanged (existing tests pass).

CLI `promptProbePreview` / `runWizardAndFinalize` (via bin `runSetup` with injected
probeModule, or direct):
- re-run stored valid caPath → gate → keep → preserves caPath + caBytes.
- re-run stored caPath → gate → change → use-file → new caPath.
- re-run stored caPath → gate → change → insecure → tlsVerify:false, caPath cleared.
- **re-run insecure account → gate → keep → tlsVerify:false preserved** (regression for
  §1.1; assert it survives into `patchChannelWithFinalValues` output AND, cheaper, that
  `runWizardAndFinalize(...).tlsVerify === false`).
- re-run stored caPath, **missing file** → missing-file banner + recovery menu (CLI gains
  this — new coverage).
- re-run stored caPath, **mismatch** → mismatch banner + recovery menu (CLI gains this).
- re-run stored caPath, server unreachable → keep-with-warning, caPath preserved.

Unit `setup-trust.ts` (stubbed prompter + stubbed probe — REQUIRED for the cases that
can't be made to look system-trusted by a fixture server):
- `reviewExistingTrust` decision table: alreadyValidated vs not; valid→keep/change;
  mismatch; unreachable; each change-menu choice.
- **change → re-probe → server now TRUSTED → `{kind:'system'}`** — MUST be a stubbed-probe
  unit test (`probeTls` → `{reachable:true, caUntrusted:false}`); there is no
  system-trusted fixture cert, so this is unwritable as integration.
- **change → re-probe → still untrusted → nested use-file / insecure / abort** — both the
  unit (stubbed) and at least one integration variant.
- `promptInsecureConfirm`, `resolveAbsPath` moved-coverage.

### Test-infra requirements (plan must honor)
- New `setup-trust.test.ts` (and any new file) MUST wipe `TRUECONF_*` in `beforeEach`
  (a leaked `TRUECONF_CA_PATH` routes the onboard caller into STEP 1 and never reaches
  the gate — silent false pass). Pin `TRUECONF_SETUP_LOCALE` if asserting Russian copy.
- Every keep / use-file / insecure test asserts `download()` not called (the fixture
  download mock writes `ca-valid` by default → a stray call masks a wrong branch).
- Verify `validateCaAgainstServer` returns `kind:'unreachable'` for a deliberately-unbound
  port; if it classifies a closed port as `mismatch`, the unreachable tests must stub the
  probe instead.

### Regression net
Full `tests/integration/setup-wizard*.test.ts`, `bin-trueconf-setup.test.ts`,
`tests/unit/channel-setup*.test.ts`, `setup-adapter.test.ts`, `setup-entry-shape.test.ts`,
`i18n.test.ts` + `npm run lint` (oxlint) + `npm run typecheck` (tsc).

**Green-baseline caveat (Windows dev machine):** at HEAD the full suite is 725 passed /
19 skipped with TWO pre-existing **Windows-only** failures, unrelated to this feature and
NOT to be counted as regressions: `tests/unit/bin-register-load-path.test.mjs` (`EPERM:
symlink`, needs admin/Developer-Mode) and `bin-trueconf-setup.test.ts › 'headless …0600
permissions'` (`expected 438 to be 384` — Windows ignores Unix file-mode). On Linux/CI
both pass. The verify step treats these two as the known baseline.

## 8. Edge cases & behavior changes (risks)

1. **Intended:** onboard "silent happy" re-run now shows a 1-confirm gate. **Two**
   existing tests change (§7): onboard silent-happy + CLI skip-probe.
2. **Latent fix:** CLI insecure re-run no longer drops `tlsVerify:false`.
3. **Intended (interactive only):** onboard unreachable-during-re-validation no longer
   throws — keeps with a security-explicit warning; headless still throws.
4. **CLI skip-probe contract narrowed:** a CLI re-run with a pinned CA now incurs a probe
   + re-validation (graceful: unreachable → keep-with-warning). A re-run with only
   useTls+port (no trust config) stays probe-free. Operators who pinned useTls+port to
   avoid a probe AND have no CA are unaffected.
5. **Probe fully unreachable on first-run fallback** (distinct from re-validation
   unreachable): unchanged HTTPS:443 fallback. Out of scope.
6. **System trust without a pinned CA / `useTls:false`:** no gate. Documented limitation.

## 9. Out of scope
- Multi-account (`accounts.<id>`) trust review.
- Pinning a CA on a system-trusted server.
- Versioning / npm release / user-facing CHANGELOG.

## 10. Rollout
- Branch `feat/wizard-change-cert-on-rerun` off `origin/main` (1.2.9).
- TDD: green baseline (minus the 2 Windows-only failures) → red tests → implement →
  verify → multi-agent code review → fix.
- No version bump; spec/plan under `docs/superpowers/` are outside the npm `files`
  allowlist (not shipped).

## 11. Review-finding → resolution map (v1 → v2)

| Finding (reviewer) | Severity | Resolved in |
| --- | --- | --- |
| CLI re-validation breaks skip-probe contract + `bin…:762` (R2 B-2, R3) | BLOCKER | §1 (only readFileSync today), §4 CLI (narrowed contract + 2nd changed test), §7, §8.4 |
| onboard insecure gate placement / double-prompt / env precedence (R1 #3, R2 B-1) | BLOCKER | §3.B, §4 onboard step 1 (first sub-branch of `useTls!==false`, `!envPath`, keep skips probe) |
| `tcFields` type omits `tlsVerify` → typecheck break (R2 C-1, R3) | BLOCKER | §1.1, §4 CLI (widen type) |
| "re-probe→trusted→system" unwritable as integration (R3, R2) | BLOCKER | §7 unit (stubbed probe) |
| i18n parity file mis-cited (R2 N-1, R3) | NIT→fix | §5 (`i18n.test.ts:17-24`), §7 |
| TrustDecision overloaded; system must clear caPath; caPath+caBytes co-required (R1 #4, R2 C-3) | CONCERN | §4 (discriminated union), §4 onboard clearFields fix, §6 |
| brand-abuse on lenient unreachable-keep (R1 #1) | CONCERN | §4 (local cast not markValidated), §6 (not branded validated; OAuth gates; tamper test) |
| network attacker forces unreachable to suppress detection (R1 #2) | CONCERN | §6 (asymmetry deliberate + documented), §5 (`keepUnreachable` copy) |
| `markValidated` private → import cycle (R2 C-2) | CONCERN | §4 (re-mint locally) |
| fake-prompter default-true confirm footgun / positional drift (R2 C-5, R3) | CONCERN | §7 fake-prompter note (gate-note load-bearing; audit queues; empty-select aborts) |
| missing test branches: CLI missing/mismatch/change-insecure, re-probe-untrusted nested (R3) | CONCERN | §7 new tests |
| new file env-leak, download() negative assertion, unreachable classification (R3) | CONCERN | §7 test-infra requirements |
| menu copy: abort label, CA-file label (R2 N-2) | NIT | §5 (`select.option.abortSetup`, `trust.review.optionCaFile`) |
| re-probe→untrusted omits TOFU (R1 #5) | NIT | §3.C (deliberate, no new exposure) |
| CLI recovery can't reuse onboard's `accept-new`/`downloadAndAudit` without a circular import (plan-phase, implied by R2 C-2) | DECISION | §3.A (CLI mismatch/missing → change menu; onboard `handleUntrustedCert` recovery unchanged), §5 (+`mismatchWarn`/`fileUnreadable`) |
