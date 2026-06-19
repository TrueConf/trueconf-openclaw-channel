# Wizard "Change cert/trust on re-run" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: this plan is executed by an **ultracode Workflow** (TDD per task, then verify, then multi-agent review, then fix). Steps use checkbox (`- [ ]`) syntax. Implement strictly task-by-task, RED before GREEN, commit per task.

**Goal:** Let an operator change the pinned CA file or TLS trust method on every interactive re-run of the TrueConf setup wizard, in both the CLI (`promptProbePreview`) and onboard (`interactiveFinalize`) paths, via a new shared `src/setup-trust.ts`.

**Architecture:** A new `src/setup-trust.ts` owns the shared trust primitives (`resolveAbsPath`, `shortFp`, `readCaFileInteractive`, `promptInsecureConfirm`) plus a new `reviewExistingTrust()` that renders a keep/change gate + change menu and returns a discriminated `TrustDecision`. Onboard inserts the gate at two points and keeps `handleUntrustedCert`'s mismatch/missing/rotation recovery byte-for-byte; CLI replaces its blind short-circuit reuse with `reviewExistingTrust` (internal re-validation). No new deps.

**Tech Stack:** TypeScript (ESM, strict), Vitest 4, oxlint, `@clack/prompts` (via the SDK `WizardPrompter`), Node ≥ 22.14.0.

**Spec:** `docs/superpowers/specs/2026-06-18-wizard-change-cert-on-rerun-design.md` (v2.1).

## Global Constraints

- **Node ≥ 22.14.0**; `npm run typecheck` (tsc, strict) and `npm run lint` (oxlint) MUST pass.
- **No new runtime dependency. No version bump** in this branch.
- **Commits:** author `Aleksandr Ponomarev <sanyasamineva@gmail.com>`, **NO `Co-Authored-By: Claude` trailer** (project override).
- **i18n:** every key needs both `en` and `ru` (enforced by TS structural typing AND by `tests/unit/i18n.test.ts:17-24` `'every key has both en and ru entries'`). Keys are flat `'a.b.c'` strings in `TRANSLATIONS` (`src/i18n.ts:9`).
- **fake-prompter footgun** (`tests/smoke/fake-prompter.ts:40`): an empty `confirm` queue returns `true` (keep), an empty `select` queue returns `''` — neither throws. Therefore: (a) the **gate NOTE assertion is load-bearing** in every gate test (a default-true confirm would pass even if the gate never rendered); (b) when editing an existing test that now also passes through the gate, audit its positional `confirmResponses`/`selectResponses` for one-slot drift; (c) the change menu MUST abort on an empty/unrecognized select value (do NOT replicate `handleUntrustedCert`'s fall-through-to-use-file at `channel-setup.ts:640`).
- **New/edited test files** wipe `TRUECONF_*` in `beforeEach` (a leaked `TRUECONF_CA_PATH` routes onboard into STEP 1 and bypasses the gate → silent false pass). Pin `process.env.TRUECONF_SETUP_LOCALE = 'ru'` when asserting Russian copy.
- **TOCTOU:** OAuth must receive the exact bytes validated in-process. `TrustDecision.pinned` carries `caBytes` co-required with `caPath`. The lenient unreachable-keep mints bytes via the documented cast escape (`bytes as unknown as ValidatedCaBytes`), **NOT** `markValidated` (importing it from `channel-setup.ts` would create a circular import); OAuth's `rejectUnauthorized:true` is the sole gate for those bytes.
- **Windows dev-machine baseline:** the full suite is green EXCEPT two pre-existing Windows-only failures that are NOT regressions and must be ignored by verify: `tests/unit/bin-register-load-path.test.mjs` (`EPERM: symlink`) and `bin-trueconf-setup.test.ts › 'headless … 0600 permissions'` (`expected 438 to be 384`). On Linux/CI both pass.

### Test-authoring discipline (MANDATORY — from plan review; applies to every test step below)

These rules override any illustrative snippet that contradicts them; where a snippet below is wrong, follow the rule.

1. **The keep gate fires FIRST.** On any pinned/insecure re-run, `reviewExistingTrust` asks the keep `confirm` before anything else. To reach the **change menu**, the FIRST `confirm` MUST be `false`. NEVER use a constant-return confirm stub (`async () => true`) for a change-path test — it can only express "keep." Use ORDERED arrays:
   - keep → `confirm:[true]` (or `[false-overwrite?...]` see rule 4).
   - change → use-file → `confirm:[false]`, `select:['use-file']`, `text:['<pem path>']`.
   - change → insecure (accepted) → `confirm:[false, true]` (decline keep, then accept the `promptInsecureConfirm`).
   - change → insecure (declined → throws) → `confirm:[false, false]`. *(With only `[false]` the insecure-confirm drains to the fake-prompter default `true` and the throw is never exercised.)*
   - change → re-probe → `confirm:[false]`, `select:['re-probe', ...]` (see rule 2).
   - change → abort / empty-select → `confirm:[false]`, `select:['abort']` / `select:[]`.
2. **`re-probe → still untrusted` consumes TWO selects:** `changeMenu` reads `select` (=`'re-probe'`), then `reprobe` reads `select` again for the nested use-file/insecure/abort menu. Queue is `select:['re-probe','use-file']` (or `['re-probe','insecure']`). Assert `probe.probeTls` WAS called (proves re-probe ran, not a use-file shortcut).
3. **Note assertions:** the smoke `makeFakePrompter.note` (tests/smoke/fake-prompter.ts) is a NO-OP. For UNIT tests use an inline prompter that captures notes in a **closure array** (`const notes:string[]=[]; note: async (b)=>{ notes.push(b) }`) — do NOT use a `this.notes = []` self-reinitialising helper. For INTEGRATION tests wrap `prompter.note` (pattern at `setup-wizard-trust.test.ts:330-334`). The gate-NOTE assertion is load-bearing in EVERY gate test (a default-true confirm would otherwise pass even if the gate never rendered).
4. **Bin/CLI tests prefix the OVERWRITE confirm.** `runSetup` on an EXISTING cfg issues `bin.overwrite.confirm` as confirm[0]. So every Task-8 confirm queue starts with `true` (overwrite), THEN the gate confirms: keep → `[true,true]`; change→use-file → `[true]` (use-file consumes `text`, no 2nd confirm); change→insecure → `[true,false,true]`.
5. **`download()` negative is required:** every keep / use-file / insecure test (onboard AND CLI) asserts `expect(download()).not.toHaveBeenCalled()` (the fixture download mock writes `ca-valid` by default → a stray call masks a wrong-branch fall-through).
6. **"probe not entered" (insecure-keep):** assert via notes — the insecure-keep note rendered and `t('probe.detecting')` did NOT — do NOT add `probeTls` to the file-level `vi.mock` (other describe blocks rely on the real probe).
7. **Env hygiene:** every NEW test file's `beforeEach` wipes all `TRUECONF_*`. Unit asserts use locale `'en'` (no `TRUECONF_SETUP_LOCALE` pin needed); integration files already pin `ru` at their `beforeEach`.
8. **Fixture limits:** there is NO system-trusted fixture cert. `change → re-probe → server trusted → {kind:'system'}` AND `change → re-probe → still untrusted` are **unit-only** (stubbed `probeTls`); they are unwritable as integration (a live fixture is always `caUntrusted:true`, and a re-probe of a server whose stored CA validates returns `caUntrusted:false` → system). Do not attempt integration variants for these two.

## File Structure

- **Create** `src/setup-trust.ts` — shared trust module (primitives + `reviewExistingTrust` + `TrustDecision`).
- **Create** `tests/unit/setup-trust.test.ts` — unit tests (stubbed prompter + stubbed probe).
- **Modify** `src/i18n.ts` — add 10 `trust.review.*` keys.
- **Modify** `src/channel-setup.ts` — remove moved primitives (re-import from `setup-trust`); onboard gate insertions + clearFields fix + unreachable leniency.
- **Modify** `src/setup-shared.ts` — `promptProbePreview` gate + `currentTlsVerify` param + `tcFields` type widen; drop inline CA-read/resolveAbsPath duplication.
- **Modify** `tests/integration/setup-wizard-trust.test.ts` — update "silent happy"; add onboard gate tests.
- **Modify** `tests/integration/bin-trueconf-setup.test.ts` — rewrite the `:762` skip-probe test; add CLI gate tests.

---

### Task 1: i18n keys

**Files:**
- Modify: `src/i18n.ts` (insert into `TRANSLATIONS` at line 106 — immediately AFTER `tls.banner.missing.reasonReadErr` (the last `missing.*` entry, :105) and BEFORE the `// Probe preview` comment (:107); do NOT split the missing block)
- Test: `tests/unit/i18n.test.ts` (parity loop at :17-24 auto-covers; add explicit render asserts)

**Interfaces:**
- Produces: 10 keys — `trust.review.keepTitle`, `.currentCaFile`, `.currentInsecure`, `.keep`, `.changePrompt`, `.optionCaFile`, `.optionReprobe`, `.keepUnreachable`, `.mismatchWarn`, `.fileUnreadable` — each callable via `t(key, locale, vars?)`.

- [ ] **Step 1: Write the failing test** — append to `tests/unit/i18n.test.ts`:

```ts
it('renders the new trust.review keys in both locales', () => {
  for (const loc of ['en', 'ru'] as const) {
    expect(t('trust.review.keep', loc)).toBeTruthy()
    expect(t('trust.review.currentCaFile', loc, { path: '/x' })).toContain('/x')
    expect(t('trust.review.keepUnreachable', loc, { error: 'E' })).toContain('E')
    expect(t('trust.review.mismatchWarn', loc, { error: 'E' })).toContain('E')
    expect(t('trust.review.fileUnreadable', loc, { path: '/x', reason: 'R' })).toContain('/x')
  }
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/unit/i18n.test.ts -t "trust.review keys"`
Expected: FAIL — `unknown translation key: trust.review.keep`.

- [ ] **Step 3: Add the keys** to `src/i18n.ts` `TRANSLATIONS` (copy verbatim — exact strings from spec §5):

```ts
  // Re-run trust review (keep/change gate + change menu)
  'trust.review.keepTitle':       { en: 'Current TLS / certificate setup', ru: 'Текущая настройка TLS / сертификата' },
  'trust.review.currentCaFile':   { en: 'Verification by CA file: {{path}}', ru: 'Проверка по CA-файлу: {{path}}' },
  'trust.review.currentInsecure': { en: 'TLS verification is disabled (insecure)', ru: 'Проверка TLS отключена (insecure)' },
  'trust.review.keep':            { en: 'Keep the current TLS / certificate setup?', ru: 'Оставить текущую настройку TLS / сертификата?' },
  'trust.review.changePrompt':    { en: 'How should TLS be verified?', ru: 'Как проверять TLS-сертификат?' },
  'trust.review.optionCaFile':    { en: 'Specify a different CA file', ru: 'Указать другой CA-файл' },
  'trust.review.optionReprobe':   { en: 'Re-detect from the server (re-probe)', ru: 'Перепроверить с сервера (re-probe)' },
  'trust.review.keepUnreachable': { en: 'Server unreachable — keeping the stored CA WITHOUT re-validation. This may be a network failure or an attacker blocking the check; the login below still verifies against this CA and fails closed. ({{error}})', ru: 'Сервер недоступен — оставляю сохранённый CA БЕЗ повторной проверки. Это может быть сбой сети или атакующий, блокирующий проверку; вход ниже всё равно проверяется по этому CA и упадёт при подмене. ({{error}})' },
  'trust.review.mismatchWarn':    { en: 'The stored CA file no longer validates this server ({{error}}). The certificate may have rotated, or this could be a MITM — verify with the admin before trusting a new one.', ru: 'Сохранённый CA-файл больше не валидирует этот сервер ({{error}}). Сертификат мог смениться, либо это MITM — сверьте с админом перед доверием новому.' },
  'trust.review.fileUnreadable':  { en: 'Stored CA file is missing or unreadable: {{path}} ({{reason}})', ru: 'Сохранённый CA-файл отсутствует или не читается: {{path}} ({{reason}})' },
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/unit/i18n.test.ts`
Expected: PASS (new test + the existing every-key parity loop).

- [ ] **Step 5: Commit**

```bash
git add src/i18n.ts tests/unit/i18n.test.ts
git commit -m "feat(i18n): add trust.review.* keys for the re-run trust gate"
```

---

### Task 2: `setup-trust.ts` + move `resolveAbsPath`/`shortFp`

**Files:**
- Create: `src/setup-trust.ts`
- Create: `tests/unit/setup-trust.test.ts`
- Modify: `src/channel-setup.ts` (delete `resolveAbsPath` at :310-315 and `shortFp` at :359-362; add `import { resolveAbsPath, shortFp } from './setup-trust'`)

**Interfaces:**
- Produces: `resolveAbsPath(raw: string): string`, `shortFp(fp: string | null | undefined): string`.

- [ ] **Step 1: Failing test** — `tests/unit/setup-trust.test.ts` (create the file WITH the env-wipe `beforeEach` and the shared closure-capturing helpers reused by Tasks 4-6):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { resolve as pathResolve } from 'node:path'
import { resolveAbsPath, shortFp } from '../../src/setup-trust'

// Global-Constraints rule 7: wipe TRUECONF_* so a leaked env can't perturb a test.
beforeEach(() => { for (const k of Object.keys(process.env)) if (k.startsWith('TRUECONF_')) delete process.env[k] })

// Shared helpers (Global-Constraints rules 1-3). ORDERED queues; confirm default = true (keep).
export function mkPrompter(q: { confirm?: boolean[]; select?: string[]; text?: string[] } = {}) {
  const c = [...(q.confirm ?? [])], s = [...(q.select ?? [])], x = [...(q.text ?? [])]
  const notes: string[] = []
  return {
    notes,
    note: async (b: string) => { notes.push(b) },
    confirm: async () => (c.length ? Boolean(c.shift()) : true),
    select: async () => (s.length ? s.shift() : ''),
    text: async () => (x.length ? x.shift() : ''),
  } as any
}
export function mkProbe(over: any = {}) {
  return {
    probeTls: async () => ({ reachable: true, useTls: true, port: 443, caUntrusted: true }),
    parseCertFromPem: () => ({ subject: 's', issuerCN: 'i', fingerprint: 'fp' }),
    validateCaAgainstServer: async () => ({ ok: true, caBytes: Buffer.from('NEWCA') }),
    ...over,
  } as any
}
export const BYTES = Buffer.from('VALID') as any // stands in for ValidatedCaBytes in unit tests

describe('setup-trust primitives', () => {
  it('resolveAbsPath expands ~ and absolutises', () => {
    expect(resolveAbsPath('~/x')).toBe(pathResolve(homedir(), 'x'))
    expect(resolveAbsPath('rel')).toBe(pathResolve('rel'))
  })
  it('shortFp truncates long fingerprints', () => {
    expect(shortFp(null)).toBe('?')
    expect(shortFp('a'.repeat(40))).toMatch(/…$/)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run tests/unit/setup-trust.test.ts`
Expected: FAIL — cannot find module `../../src/setup-trust`.

- [ ] **Step 3: Create `src/setup-trust.ts`** with the two helpers (move verbatim from `channel-setup.ts`):

```ts
import { resolve as pathResolve } from 'node:path'
import { homedir } from 'node:os'

export function resolveAbsPath(raw: string): string {
  const expanded = raw.startsWith('~/') || raw === '~'
    ? raw.replace(/^~/, homedir())
    : raw
  return pathResolve(expanded)
}

export function shortFp(fp: string | null | undefined): string {
  if (!fp) return '?'
  return fp.length > 29 ? `${fp.slice(0, 29)}…` : fp
}
```

- [ ] **Step 4: Update `src/channel-setup.ts`** — delete the local `resolveAbsPath` (:310-315) and `shortFp` (:359-362); add near the other imports: `import { resolveAbsPath, shortFp } from './setup-trust'`.

- [ ] **Step 5: Run the suite, verify green** (no behavior change)

Run: `npx vitest run tests/unit/setup-trust.test.ts tests/unit/channel-setup.test.ts tests/integration/setup-wizard-trust.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/setup-trust.ts tests/unit/setup-trust.test.ts src/channel-setup.ts
git commit -m "refactor: move resolveAbsPath/shortFp into setup-trust.ts"
```

---

### Task 3: move `readCaFileInteractive` + add `promptInsecureConfirm`

**Files:**
- Modify: `src/setup-trust.ts` (add the two functions + imports)
- Modify: `src/channel-setup.ts` (delete local `readCaFileInteractive` at :366-443 and its `MAX_CA_FILE_ATTEMPTS` const at :364; add `readCaFileInteractive` to the `./setup-trust` import; factor the inline insecure note+confirm in `handleUntrustedCert` (:630-637) to call `promptInsecureConfirm`)
- Test: `tests/unit/setup-trust.test.ts`

**Interfaces:**
- Consumes: `resolveAbsPath`, `shortFp` (Task 2), `t` (i18n), `ProbeModule` ({ parseCertFromPem, validateCaAgainstServer }), `ValidatedCaBytes`.
- Produces:
  - `readCaFileInteractive(args: { prompter: WizardPrompter; probe: ProbeModule; host: string; port: number; locale: Locale }): Promise<{ nextCaPath: string; nextCaBytes: ValidatedCaBytes }>`
  - `promptInsecureConfirm(args: { prompter: WizardPrompter; locale: Locale }): Promise<boolean>`

> **Note on `readCaFileInteractive`:** the version in `channel-setup.ts:366` imports `parseCertFromPem`/`validateCaAgainstServer` from the static `./probe.mjs`. To avoid a `setup-trust ↔ channel-setup` cycle and keep the module injectable, the moved version takes a `probe: ProbeModule` arg instead of static imports. Onboard callers pass the `probe.mjs` namespace; CLI passes its `probeModule`.

- [ ] **Step 1: Failing test** — add to `tests/unit/setup-trust.test.ts`:

```ts
import { promptInsecureConfirm } from '../../src/setup-trust'

it('promptInsecureConfirm shows the warning note and returns the confirm', async () => {
  const notes: string[] = []
  const prompter: any = {
    note: async (b: string) => { notes.push(b) },
    confirm: async () => true,
  }
  const ok = await promptInsecureConfirm({ prompter, locale: 'en' })
  expect(ok).toBe(true)
  expect(notes.join('\n')).toMatch(/without TLS certificate verification/i)
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run tests/unit/setup-trust.test.ts -t promptInsecureConfirm`
Expected: FAIL — `promptInsecureConfirm` is not exported.

- [ ] **Step 3: Implement** in `src/setup-trust.ts`:

```ts
import { readFileSync } from 'node:fs'
import type { WizardPrompter } from 'openclaw/plugin-sdk/setup'
import type { CertSummary, ValidatedCaBytes, ValidateCaAgainstServerParams, ValidateCaAgainstServerResult } from './probe.d.mts'
import type { Locale } from './i18n'
import { t } from './i18n'

export interface ProbeModule {
  probeTls: (p: { host: string; port?: number }) => Promise<{ reachable: boolean; useTls: boolean; port: number; caUntrusted?: boolean; cert?: CertSummary; error?: string }>
  parseCertFromPem: (b: Buffer | Uint8Array) => CertSummary | null
  validateCaAgainstServer: (p: ValidateCaAgainstServerParams) => Promise<ValidateCaAgainstServerResult>
}

export async function promptInsecureConfirm(args: { prompter: WizardPrompter; locale: Locale }): Promise<boolean> {
  const { prompter, locale } = args
  await prompter.note(t('tls.insecure.warning', locale), t('tls.untrusted.title', locale))
  return prompter.confirm({ message: t('tls.insecure.confirm', locale), initialValue: false })
}

const MAX_CA_FILE_ATTEMPTS = 3

export async function readCaFileInteractive(args: {
  prompter: WizardPrompter; probe: ProbeModule; host: string; port: number; locale: Locale
}): Promise<{ nextCaPath: string; nextCaBytes: ValidatedCaBytes }> {
  // (move the body verbatim from channel-setup.ts:366-443, replacing the static
  //  parseCertFromPem/validateCaAgainstServer calls with args.probe.parseCertFromPem /
  //  args.probe.validateCaAgainstServer, and using resolveAbsPath/shortFp from this module.)
}
```

(The full `readCaFileInteractive` body is the current `channel-setup.ts:366-443` text with `parseCertFromPem(` → `probe.parseCertFromPem(`, `validateCaAgainstServer(` → `probe.validateCaAgainstServer(`, and `host`/`port` from args.)

- [ ] **Step 4: Update `channel-setup.ts`** — delete local `MAX_CA_FILE_ATTEMPTS` + `readCaFileInteractive`; add `readCaFileInteractive`, `promptInsecureConfirm`, `ProbeModule` to the `./setup-trust` import. At its call sites in `handleUntrustedCert` (:564, :605, :640) pass `{ prompter, probe: { probeTls, parseCertFromPem, validateCaAgainstServer }, host, port, locale }` (the static `probe.mjs` imports already in scope at :9). Replace the inline insecure note+confirm at :630-637 with `const confirmed = await promptInsecureConfirm({ prompter, locale })`.

- [ ] **Step 5: Run, verify green**

Run: `npx vitest run tests/unit/setup-trust.test.ts tests/integration/setup-wizard-trust.test.ts tests/unit/channel-setup.test.ts`
Expected: PASS (use-file/insecure onboard behavior unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/setup-trust.ts src/channel-setup.ts tests/unit/setup-trust.test.ts
git commit -m "refactor: move readCaFileInteractive + factor promptInsecureConfirm into setup-trust.ts"
```

---

### Task 4: `TrustDecision` + `reviewExistingTrust` — pinned-valid gate (alreadyValidated)

**Files:**
- Modify: `src/setup-trust.ts`
- Test: `tests/unit/setup-trust.test.ts`

**Interfaces:**
- Produces:
  - `type TrustDecision = { kind: 'pinned'; caPath: string; caBytes: ValidatedCaBytes } | { kind: 'insecure' } | { kind: 'system' }`
  - `reviewExistingTrust(args: ReviewExistingTrustArgs): Promise<TrustDecision>` where
    `ReviewExistingTrustArgs = { prompter: WizardPrompter; probe: ProbeModule; host: string; port: number; current: { caPath?: string; tlsVerify?: boolean }; alreadyValidated?: { caBytes: ValidatedCaBytes }; locale: Locale }`.
- This task implements ONLY: the `alreadyValidated` pinned path → keep/change gate, where "change" throws a `not-implemented` placeholder replaced in Task 5. (Keeps the task independently testable.)

> **Depends on Task 1** — `t('trust.review.*')` does not typecheck until the keys exist (`TranslationKey` union). Task 1 is committed first; do not run typecheck on this task before Task 1.

- [ ] **Step 1: Failing test** — add to `tests/unit/setup-trust.test.ts` (reuse `mkPrompter`/`BYTES` defined in Task 2; import `reviewExistingTrust`):

```ts
it('alreadyValidated + keep → pinned, gate note shown', async () => {
  const prompter = mkPrompter({ confirm: [true] })   // keep
  const d = await reviewExistingTrust({
    prompter, probe: {} as any, host: 'h', port: 443,
    current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
  })
  expect(d).toEqual({ kind: 'pinned', caPath: expect.stringContaining('ca.pem'), caBytes: BYTES })
  expect(prompter.notes.join('\n')).toMatch(/Verification by CA file/)  // gate note rendered
})
```

- [ ] **Step 2: Run, verify fail** — `reviewExistingTrust` not exported.

- [ ] **Step 3: Implement** the type + the alreadyValidated keep path (change → temporary throw):

```ts
export type TrustDecision =
  | { kind: 'pinned'; caPath: string; caBytes: ValidatedCaBytes }
  | { kind: 'insecure' }
  | { kind: 'system' }

export interface ReviewExistingTrustArgs {
  prompter: WizardPrompter; probe: ProbeModule; host: string; port: number
  current: { caPath?: string; tlsVerify?: boolean }
  alreadyValidated?: { caBytes: ValidatedCaBytes }
  locale: Locale
}

export async function reviewExistingTrust(args: ReviewExistingTrustArgs): Promise<TrustDecision> {
  const { prompter, host, port, current, alreadyValidated, locale } = args
  if (current.caPath && alreadyValidated) {
    const resolved = resolveAbsPath(current.caPath)
    await prompter.note(t('trust.review.currentCaFile', locale, { path: resolved }), t('trust.review.keepTitle', locale))
    const keep = await prompter.confirm({ message: t('trust.review.keep', locale), initialValue: true })
    if (keep) return { kind: 'pinned', caPath: resolved, caBytes: alreadyValidated.caBytes }
    return changeMenu(args)   // implemented in Task 5
  }
  throw new Error('reviewExistingTrust: branch not implemented (Task 5/6)')
}

async function changeMenu(_args: ReviewExistingTrustArgs): Promise<TrustDecision> {
  throw new Error('changeMenu not implemented (Task 5)')
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/unit/setup-trust.test.ts -t "alreadyValidated"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/setup-trust.ts tests/unit/setup-trust.test.ts
git commit -m "feat(setup-trust): TrustDecision + reviewExistingTrust pinned keep gate"
```

---

### Task 5: `reviewExistingTrust` — insecure gate + change menu

**Files:**
- Modify: `src/setup-trust.ts` (implement `changeMenu`, `reprobe`, and the insecure branch)
- Test: `tests/unit/setup-trust.test.ts`

**Interfaces:**
- Consumes: `readCaFileInteractive`, `promptInsecureConfirm` (Task 3), `ProbeModule.probeTls`.
- Produces: complete `reviewExistingTrust` insecure branch + `changeMenu` (use-file / insecure / re-probe / abort) + `reprobe` (system vs nested fresh-untrusted).

> **Depends on Task 1** (i18n keys must exist to typecheck `t('trust.review.*')`).

- [ ] **Step 1: Failing tests** — add to `tests/unit/setup-trust.test.ts`, reusing `mkPrompter`/`mkProbe`/`BYTES` from Task 2 (ORDERED queues per Global-Constraints rules 1-2; the keep gate fires first → change paths lead with `confirm:false`).

  Canonical (correct) change→insecure test:

```ts
it('pinned valid → change → insecure (accepted) → kind:insecure', async () => {
  const prompter = mkPrompter({ confirm: [false, true], select: ['insecure'] })
  const d = await reviewExistingTrust({
    prompter, probe: mkProbe(), host: 'h', port: 443,
    current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
  })
  expect(d).toEqual({ kind: 'insecure' })
  expect(prompter.notes.join('\n')).toMatch(/Verification by CA file/) // gate note rendered
})
```

  **Full matrix** (each: assert the decision; assert the gate note rendered via `prompter.notes`). `download` is not referenced at the unit layer — the negative assertion belongs to the integration tests (Tasks 7/8), per Global-Constraints rule 5:
  - `insecure account → keep` → `current:{tlsVerify:false}` (no `caPath`/`alreadyValidated`), `confirm:[true]` → `{kind:'insecure'}`; note matches `/disabled \(insecure\)/`.
  - `insecure account → change → use-file` → `current:{tlsVerify:false}`, `confirm:[false]`, `select:['use-file']`, `text:['/new.pem']`, `probe:mkProbe()` → `{kind:'pinned', caPath: expect.stringContaining('new.pem'), caBytes: Buffer.from('NEWCA')}`.
  - `pinned valid → change → use-file` → `current:{caPath:'/ca.pem'}` + `alreadyValidated:{caBytes:BYTES}`, `confirm:[false]`, `select:['use-file']`, `text:['/new.pem']` → `{kind:'pinned'}` new path.
  - `pinned valid → change → insecure (declined)` → `confirm:[false, false]` (decline keep, decline insecure), `select:['insecure']` → **rejects** (`/declined/`). *(With `[false]` only, the insecure-confirm drains to default true → returns insecure → throw never exercised.)*
  - `pinned valid → change → re-probe → trusted` → `confirm:[false]`, `select:['re-probe']`, `probe:mkProbe({ probeTls: async () => ({ reachable:true, useTls:true, port:443, caUntrusted:false }) })` → `{kind:'system'}`; assert `probeTls` was called (use a `vi.fn()` for it).
  - `pinned valid → change → re-probe → still untrusted → use-file` → `confirm:[false]`, `select:['re-probe','use-file']` (TWO slots — rule 2), `text:['/new.pem']`, `probe:mkProbe()` (caUntrusted:true) → `{kind:'pinned'}`; assert `probeTls` called.
  - `pinned valid → change → abort` → `confirm:[false]`, `select:['abort']` → **rejects** (`/cancelled/`).
  - `pinned valid → change → empty select` → `confirm:[false]`, `select:[]` (drained → `''`) → **rejects** (`/cancelled/`); MUST NOT route to use-file.

- [ ] **Step 2: Run, verify fail** (changeMenu throws not-implemented).

- [ ] **Step 3: Implement** in `src/setup-trust.ts`:

```ts
// insecure branch in reviewExistingTrust (before the pinned branch's throw):
if (current.tlsVerify === false && !current.caPath) {
  await args.prompter.note(t('trust.review.currentInsecure', args.locale), t('trust.review.keepTitle', args.locale))
  const keep = await args.prompter.confirm({ message: t('trust.review.keep', args.locale), initialValue: true })
  if (keep) return { kind: 'insecure' }
  return changeMenu(args)
}

async function changeMenu(args: ReviewExistingTrustArgs): Promise<TrustDecision> {
  const { prompter, probe, host, port, locale } = args
  const choice = await prompter.select<string>({
    message: t('trust.review.changePrompt', locale),
    options: [
      { value: 'use-file', label: t('trust.review.optionCaFile', locale) },
      { value: 'insecure', label: t('tls.untrusted.choice.insecure', locale) },
      { value: 're-probe', label: t('trust.review.optionReprobe', locale) },
      { value: 'abort',    label: t('select.option.abortSetup', locale) },
    ],
  })
  if (choice === 'use-file') {
    const r = await readCaFileInteractive({ prompter, probe, host, port, locale })
    return { kind: 'pinned', caPath: r.nextCaPath, caBytes: r.nextCaBytes }
  }
  if (choice === 'insecure') {
    const ok = await promptInsecureConfirm({ prompter, locale })
    if (!ok) throw new Error(`Trust change: user declined to disable verification on ${host}`)
    return { kind: 'insecure' }
  }
  if (choice === 're-probe') return reprobe(args)
  throw new Error(`Trust change cancelled on ${host} (choice="${choice}")`)
}

async function reprobe(args: ReviewExistingTrustArgs): Promise<TrustDecision> {
  const { prompter, probe, host, port, locale } = args
  const p = await probe.probeTls({ host, port })
  if (p.reachable && !p.caUntrusted) return { kind: 'system' }
  // still untrusted → fresh-untrusted sub-flow, NO TOFU
  const choice = await prompter.select<string>({
    message: t('select.whatToDo', locale),
    options: [
      { value: 'use-file', label: t('tls.untrusted.choice.use-file', locale) },
      { value: 'insecure', label: t('tls.untrusted.choice.insecure', locale) },
      { value: 'abort',    label: t('select.option.abortSetup', locale) },
    ],
  })
  if (choice === 'use-file') {
    const r = await readCaFileInteractive({ prompter, probe, host, port, locale })
    return { kind: 'pinned', caPath: r.nextCaPath, caBytes: r.nextCaBytes }
  }
  if (choice === 'insecure') {
    const ok = await promptInsecureConfirm({ prompter, locale })
    if (!ok) throw new Error(`Trust change: user declined insecure on ${host}`)
    return { kind: 'insecure' }
  }
  throw new Error(`Trust change cancelled on ${host} after re-probe`)
}
```

- [ ] **Step 4: Run, verify the matrix passes**

Run: `npx vitest run tests/unit/setup-trust.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/setup-trust.ts tests/unit/setup-trust.test.ts
git commit -m "feat(setup-trust): change menu (use-file/insecure/re-probe) + insecure gate"
```

---

### Task 6: `reviewExistingTrust` — CLI internal re-validation (no alreadyValidated)

**Files:**
- Modify: `src/setup-trust.ts`
- Test: `tests/unit/setup-trust.test.ts`

**Interfaces:**
- Produces: the `current.caPath && !alreadyValidated` branch of `reviewExistingTrust` — re-reads + re-validates; valid→gate, unreadable→`fileUnreadable` note+changeMenu, mismatch→`mismatchWarn` note+changeMenu, unreachable→lenient keep (cast, NOT `markValidated`).

> **Depends on Task 1** (i18n keys).

- [ ] **Step 1: Failing tests** — add to `tests/unit/setup-trust.test.ts` (reuse `mkPrompter`/`BYTES` from Task 2; these branches have NO keep-gate confirm — mismatch/unreadable call `changeMenu` directly, so `select:['use-file']` is the first prompt; unreachable consumes no prompt at all):
  - `CLI valid → keep` → write a real tmp PEM at `caPath`, `mkProbe({ validateCaAgainstServer: async () => ({ ok:true, caBytes: BYTES }) })`, `confirm:[true]` → `{kind:'pinned', caBytes:BYTES}`.
  - `CLI mismatch → change menu` → `mkProbe({ validateCaAgainstServer: async () => ({ ok:false, kind:'mismatch', error:'e', serverCert:{ issuerCN:'x' } }) })`, `select:['use-file']`, `text:['/new.pem']` → `{kind:'pinned'}`; assert a note matched `/no longer validates/`.
  - `CLI unreadable → change menu` → `caPath:'/definitely-missing.pem'`, `select:['use-file']`, `text:['/new.pem']` → `{kind:'pinned'}`; assert note `/missing or unreadable/`.
  - `CLI unreachable → lenient keep` (below).

```ts
it('CLI unreachable during re-validation → lenient keep with warning', async () => {
  const tmp = join(mkdtempSync(join(tmpdir(), 'st-')), 'ca.pem'); writeFileSync(tmp, 'PEMBYTES')
  const prompter = mkPrompter({})  // unreachable branch consumes no confirm/select
  const probe = mkProbe({ validateCaAgainstServer: async () => ({ ok: false, kind: 'unreachable', error: 'ECONNREFUSED' }) })
  const d = await reviewExistingTrust({ prompter, probe, host: 'h', port: 443, current: { caPath: tmp }, locale: 'en' })
  expect(d.kind).toBe('pinned')
  expect(Buffer.from((d as any).caBytes).toString()).toBe('PEMBYTES')
  expect(prompter.notes.join('\n')).toMatch(/WITHOUT re-validation/)
})
```

> **§6 fail-closed proof lives in Task 8** (it must drive the CALLER's OAuth step — `reviewExistingTrust` alone never calls `validateOAuthCredentials`). The unit test above proves the lenient branch returns the *stored* bytes; Task 8 proves those un-revalidated bytes still make OAuth fail closed (`category:'tls'`), not silently save.

- [ ] **Step 2: Run, verify fail** (branch throws not-implemented from Task 4).

- [ ] **Step 3: Implement** the branch in `reviewExistingTrust` (replace the Task-4 `throw`):

```ts
if (current.caPath && !alreadyValidated) {
  const resolved = resolveAbsPath(current.caPath)
  let bytes: Buffer
  try { bytes = readFileSync(resolved) }
  catch (err) {
    await prompter.note(t('trust.review.fileUnreadable', locale, { path: resolved, reason: (err as Error).message }), t('trust.review.keepTitle', locale))
    return changeMenu(args)
  }
  const v = await args.probe.validateCaAgainstServer({ caBytes: bytes, host, port })
  if (v.ok) {
    await prompter.note(t('trust.review.currentCaFile', locale, { path: resolved }), t('trust.review.keepTitle', locale))
    const keep = await prompter.confirm({ message: t('trust.review.keep', locale), initialValue: true })
    if (keep) return { kind: 'pinned', caPath: resolved, caBytes: v.caBytes }
    return changeMenu(args)
  }
  if (v.kind === 'unreachable') {
    await prompter.note(t('trust.review.keepUnreachable', locale, { error: v.error }), t('trust.review.keepTitle', locale))
    // NOT markValidated: these bytes were not server-validated this run; OAuth's
    // rejectUnauthorized:true is the sole gate (see spec §6).
    return { kind: 'pinned', caPath: resolved, caBytes: bytes as unknown as ValidatedCaBytes }
  }
  await prompter.note(t('trust.review.mismatchWarn', locale, { error: v.error }), t('trust.review.keepTitle', locale))
  return changeMenu(args)
}
```

(Move the insecure branch and this branch ABOVE the final `throw`; remove the Task-4 placeholder throw.)

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/unit/setup-trust.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/setup-trust.ts tests/unit/setup-trust.test.ts
git commit -m "feat(setup-trust): CLI internal re-validation (valid/mismatch/unreadable/unreachable)"
```

---

### Task 7: onboard integration (`interactiveFinalize`)

**Files:**
- Modify: `src/channel-setup.ts` (insecure pre-probe gate; valid-CA gate at :569; clearFields system-clear; unreachable leniency at :574-578)
- Modify: `tests/integration/setup-wizard-trust.test.ts` (update "silent happy"; add onboard gate tests)

**Interfaces:**
- Consumes: `reviewExistingTrust`, `TrustDecision` (Tasks 4-6).

- [ ] **Step 1: Update the changed test + add new ones** (RED). In `setup-wizard-trust.test.ts`. This file pins `TRUECONF_SETUP_LOCALE='ru'` (its `beforeEach`), so the locale picker is skipped and `selectResponses` go straight to the change menu. Wrap `prompter.note` to capture notes (pattern at :330-334). Per Global-Constraints rule 5 EVERY keep/use-file/insecure case asserts `expect(download()).not.toHaveBeenCalled()`; per rule 6 assert "probe not entered" via notes (insecure-keep note rendered, `t('probe.detecting','ru')` NOT in captured notes) — do NOT touch the file-level `vi.mock`.
  - Rename `'silent happy …'` → `'re-run: valid CA → gate → keep preserves caPath'`; cfg `{useTls:true, caPath: ca-valid.pem}`, `makeFakePrompter({ confirmResponses:[true] })`; assert a note matches `/Текущая настройка TLS/`, caPath preserved, `download()` not called, OAuth got the bytes.
  - Add (cfg `{useTls:true, caPath: ca-valid.pem}`, server `ca-valid`):
    - change→use-file: `confirmResponses:[false]`, `selectResponses:['use-file']`, `textResponses:[ca-valid.pem]` → caPath = file; `download()` not called.
    - change→insecure: `confirmResponses:[false,true]`, `selectResponses:['insecure']` → `tlsVerify:false`, **assert `savedCfg.caPath` is undefined** (the existing `tlsVerify===false` clearFields branch clears the prior caPath), OAuth `tlsVerify:false`+no ca; `download()` not called.
    - change→cancel: `confirmResponses:[false]`, `selectResponses:['abort']` → rejects.
    - change→re-probe→system AND →still-untrusted: **OMIT here — unit-only** (Global-Constraints rule 8: no trusted/untrusted-after-reprobe fixture exists). Covered by Task 5 unit tests.
  - Insecure account (cfg `{useTls:true, tlsVerify:false}`, NO env):
    - keep: `confirmResponses:[true]` → `tlsVerify:false` preserved; assert the insecure note rendered AND `probe.detecting` note absent (probe not entered, rule 6); `download()` not called.
    - change→use-file: `confirmResponses:[false]`, `selectResponses:['use-file']`, `textResponses:[ca-valid.pem]` → caPath set, `tlsVerify` cleared; `download()` not called.

- [ ] **Step 2: Run, verify the new/renamed tests FAIL** (gate not wired yet)

Run: `npx vitest run tests/integration/setup-wizard-trust.test.ts`
Expected: FAIL (gate notes absent / silent reuse).

- [ ] **Step 3: Wire onboard** in `src/channel-setup.ts` `interactiveFinalize`:
  - **(3a) Insecure pre-probe gate** — at the top of the `else if (useTls !== false)` arm (:704), before `prompter.note(probe.detecting…)`:

```ts
    if (tc.tlsVerify === false) {
      const decision = await reviewExistingTrust({
        prompter, probe: { probeTls, parseCertFromPem, validateCaAgainstServer }, host: serverUrl, port: port ?? 443,
        current: { tlsVerify: false }, locale,
      })
      if (decision.kind === 'insecure') { tlsVerify = false; useTls = true; port = port ?? 443 }
      else if (decision.kind === 'pinned') { caPath = decision.caPath; caBytes = decision.caBytes; useTls = true; port = port ?? 443 }
      else { /* system */ useTls = true; port = port ?? 443 }
      // skip probe + handleUntrustedCert entirely
    } else {
      // existing STEP 2 probe block …
    }
```

  - **(3b) Valid-CA gate** — replace `channel-setup.ts:569` `return { nextCaPath: resolved, nextCaBytes: v.caBytes }` with:

```ts
      const decision = await reviewExistingTrust({
        prompter, probe: { probeTls, parseCertFromPem, validateCaAgainstServer }, host, port,
        current: { caPath: resolved }, alreadyValidated: { caBytes: v.caBytes }, locale,
      })
      if (decision.kind === 'pinned') return { nextCaPath: decision.caPath, nextCaBytes: decision.caBytes }
      if (decision.kind === 'insecure') return { tlsVerify: false }
      return {} // system trust → caller clears caPath
```

  (Widen `handleUntrustedCert`'s return type to also allow `{}`.)
  - **(3c) Unreachable leniency** — at `channel-setup.ts:574-578` (the `if (v.kind === 'unreachable') throw …` inside the existing-CA branch) replace the throw with:

```ts
      if (v.kind === 'unreachable') {
        await prompter.note(t('trust.review.keepUnreachable', locale, { error: v.error }), t('trust.review.keepTitle', locale))
        return { nextCaPath: resolved, nextCaBytes: storedBytes as unknown as ValidatedCaBytes }
      }
```

  - **(3d) clearFields system-clear** — in the post-OAuth clear block (:788-795), when the trust review produced system trust (caPath undefined AND tlsVerify undefined AND the prior `tc.caPath` was set), ensure `caPath` is cleared:

```ts
  } else {
    clearFields.push('tlsVerify')
    if (tc.caPath && caPath === undefined) clearFields.push('caPath')
  }
```

- [ ] **Step 4: Run, verify green**

Run: `npx vitest run tests/integration/setup-wizard-trust.test.ts tests/unit/channel-setup.test.ts`
Expected: PASS (incl. unchanged mismatch/missing/rotation).

- [ ] **Step 5: Commit**

```bash
git add src/channel-setup.ts tests/integration/setup-wizard-trust.test.ts
git commit -m "feat(onboard): keep/change trust gate on re-run (interactiveFinalize)"
```

---

### Task 8: CLI integration (`promptProbePreview` / `runWizardAndFinalize`)

**Files:**
- Modify: `src/setup-shared.ts` (`promptProbePreview` signature + short-circuit gate; widen `tcFields` type; `runWizardAndFinalize` passes `tcFields.tlsVerify`; drop the inline CA-read + inline resolveAbsPath, importing from `setup-trust`)
- Modify: `tests/integration/bin-trueconf-setup.test.ts` (rewrite `:762`; add CLI gate tests)

**Interfaces:**
- Consumes: `reviewExistingTrust`, `resolveAbsPath` (setup-trust).

- [ ] **Step 1: Rewrite `:762` + add CLI tests** (RED). In `bin-trueconf-setup.test.ts`. **Confirm-queue ordering (Global-Constraints rule 4):** `runSetup` on an EXISTING cfg issues `bin.overwrite.confirm` FIRST, then (if a password is stored) the password-keep confirm, THEN the gate's keep/change confirm. The queues below assume the existing-cfg fixtures used by the surrounding tests (overwrite present); **VERIFY the exact positions by running the RED test** — the bin's prompt order is the source of truth, adjust the leading slots to match. Per rule 5, every keep/use-file/insecure case asserts `expect(download()).not.toHaveBeenCalled()`.
  - Rewrite `'skip-probe path preserves existing cfg.caPath…'` → `'re-run: re-validates and keeps stored caPath'`: probeModule stub provides `validateCaAgainstServer: async () => ({ ok:true, caBytes: <validatedBytes> })` + `parseCertFromPem` + a benign `probeTls` (the keep path won't call it). `confirmResponses:[true, true]` (overwrite, keep). Assert caPath preserved into saved cfg + OAuth received the validated bytes + `download()` not called.
  - re-run change→use-file → `confirmResponses:[true, false]` (overwrite, keep=NO), `selectResponses:['use-file']`, `textResponses:[validCa]`, stub `validateCaAgainstServer→ok` → saved caPath = new file; `download()` not called.
  - re-run change→insecure → `confirmResponses:[true, false, true]` (overwrite, keep=NO, insecure-confirm=YES), `selectResponses:['insecure']` → saved `tlsVerify:false`, **no caPath**; `download()` not called.
  - **§1.1 regression** — re-run insecure account → cfg `{useTls:true, port, tlsVerify:false}`, `confirmResponses:[true, true]` (overwrite, keep) → saved `tlsVerify:false` preserved (`expect(written.channels.trueconf.tlsVerify).toBe(false)`). Also add a cheaper direct assertion: `runWizardAndFinalize(...)` returns `tlsVerify:false`.
  - re-run stored caPath missing → cfg `{useTls:true, port, caPath:'/nope.pem'}`, `confirmResponses:[true]` (overwrite), `selectResponses:['abort']` → rejects; a captured note matches `/missing or unreadable/`.
  - **§6 fail-closed proof (security, REQUIRED)** — `'re-run: unreachable-kept un-revalidated CA still fails OAuth closed'`: cfg `{useTls:true, port, caPath: <readable file containing the WRONG/tampered CA>}`; probeModule stub `validateCaAgainstServer: async () => ({ ok:false, kind:'unreachable', error:'ECONNREFUSED' })` (forces the lenient keep → reviewExistingTrust returns the stored tampered bytes) AND `validateOAuthCredentials: async () => ({ ok:false, category:'tls', error:'self-signed cert in chain' })` (models `rejectUnauthorized:true` rejecting the tampered CA). `confirmResponses:[true, false]` (overwrite, then decline the save-anyway prompt). Assert: the flow **rejects** with `/tls/` (NOT a silent save), AND `validateOAuthCredentials` was called with `ca` = the stored tampered bytes (proves the lenient bytes were threaded to OAuth and gated there).

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run tests/integration/bin-trueconf-setup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire CLI** in `src/setup-shared.ts`:
  - Add import: `import { resolveAbsPath, reviewExistingTrust } from './setup-trust'`.
  - Widen the `tcFields` inline type (:429-436) with `tlsVerify?: boolean`. In `runWizardAndFinalize`, pass `tcFields.tlsVerify` to `promptProbePreview` (add the 7th arg before `t, locale`).
  - Change `promptProbePreview` signature to add `currentTlsVerify: boolean | undefined`. Replace the short-circuit body (:161-183):

```ts
  if (currentUseTls !== undefined && currentPort !== undefined) {
    const hasTrust = (currentCaPath !== undefined) || (currentTlsVerify === false)
    if (currentUseTls !== false && hasTrust) {
      const decision = await reviewExistingTrust({
        // setup-shared's ProbeModule is a superset of setup-trust's (it adds
        // validateOAuthCredentials), so the assignment typechecks WITHOUT a cast —
        // do NOT write `as unknown as TrustProbe` (it would erase the probe-seam guarantee).
        prompter, probe: probeModule, host: serverUrl, port: currentPort,
        current: { caPath: currentCaPath, tlsVerify: currentTlsVerify }, locale,
      })
      if (decision.kind === 'pinned') return { useTls: true, port: currentPort, caPath: decision.caPath, caBytes: decision.caBytes, tlsVerify: undefined }
      if (decision.kind === 'insecure') return { useTls: true, port: currentPort, caPath: undefined, caBytes: undefined, tlsVerify: false }
      return { useTls: true, port: currentPort, caPath: undefined, caBytes: undefined, tlsVerify: undefined } // system
    }
    // no trust config → existing probe-free reuse
    const effectiveCaPath = currentUseTls === false ? undefined : currentCaPath
    let caBytes: Buffer | Uint8Array | undefined
    if (effectiveCaPath) {
      try { caBytes = readFileSync(effectiveCaPath) }
      catch (err) { throw new Error(`CA file unreadable: ${effectiveCaPath} (${err instanceof Error ? err.message : String(err)})`) }
    }
    return { useTls: currentUseTls, port: currentPort, caPath: effectiveCaPath, caBytes, tlsVerify: undefined }
  }
```

  - In the inline use-file branch lower in `promptProbePreview` (:220-221), replace the local `homedir()/pathResolve` expansion with `resolveAbsPath(raw)` (DRY; behavior identical).

- [ ] **Step 4: Run, verify green + typecheck**

Run: `npx vitest run tests/integration/bin-trueconf-setup.test.ts && npm run typecheck`
Expected: PASS (typecheck clean — `tcFields.tlsVerify` now typed).

- [ ] **Step 5: Commit**

```bash
git add src/setup-shared.ts tests/integration/bin-trueconf-setup.test.ts
git commit -m "feat(cli): keep/change trust gate on re-run + fix insecure-drop (promptProbePreview)"
```

---

### Task 9: Full verify

- [ ] **Step 1: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: green EXCEPT the two known Windows-only baseline failures (`bin-register-load-path` EPERM symlink; `headless 0600 permissions`). On Linux/CI: fully green. No OTHER failures.

- [ ] **Step 3: Fix any straggler, then final commit** (only if needed)

```bash
git add -A
git commit -m "test: stabilize re-run trust gate suite"
```

## Self-Review (run after writing; fix inline)

- **Spec coverage:** §3 decision tree → Tasks 4-8; §4 architecture (setup-trust + integration) → Tasks 2-8; §5 i18n → Task 1; §6 invariants (TOCTOU, lenient-no-brand, clearFields) → Tasks 6/7 + the **§6 fail-closed OAuth test → Task 8**; §7 tests (2 changed + matrix + unit) → Tasks 7/8 + 4-6; §8 risks → covered in test matrix. CLI mismatch/missing-via-change-menu (§3.A v2.1) → Task 6.
- **Type consistency:** `TrustDecision`/`ReviewExistingTrustArgs`/`ProbeModule` defined Task 3-4, consumed identically Tasks 5-8. `reviewExistingTrust` signature stable across callers.
- **Placeholder scan:** the only deliberate intermediate placeholder is the Task-4 `changeMenu` throw, explicitly replaced in Task 5 (RED→GREEN sequencing, not a plan gap).

## Revision log

- **v2 (post plan-review):** incorporated 3 plan reviews. Added: central "Test-authoring discipline" rules (keep-gate-first ordered confirm queues, two-select re-probe, bin overwrite-confirm prefix, download-not-called, closure-array note capture, env-wipe, fixture limits); the **§6 fail-closed OAuth test** (Task 8) the security review flagged as a BLOCKER; shared `mkPrompter`/`mkProbe`/`BYTES` helpers in Task 2 (replacing a buggy note-capture helper); corrected the Task-5 matrix queues; dropped the needless `probeModule as unknown as TrustProbe` cast; fixed the Task-1 key-insertion line; Task-1 dependency notes on Tasks 4-6.
