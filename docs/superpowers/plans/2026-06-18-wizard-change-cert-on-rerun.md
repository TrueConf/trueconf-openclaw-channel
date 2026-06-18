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
- Modify: `src/i18n.ts` (add to `TRANSLATIONS`, after the existing `tls.banner.missing.*` block, ~line 105)
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

- [ ] **Step 1: Failing test** — `tests/unit/setup-trust.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { resolve as pathResolve } from 'node:path'
import { resolveAbsPath, shortFp } from '../../src/setup-trust'

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

- [ ] **Step 1: Failing tests** — add to `tests/unit/setup-trust.test.ts`:

```ts
import { reviewExistingTrust } from '../../src/setup-trust'

function fakePrompter(opts: { confirm?: boolean[]; select?: string[]; note?: string[] } = {}) {
  const confirm = [...(opts.confirm ?? [])], select = [...(opts.select ?? [])]
  return {
    notes: opts.note ?? [],
    note: async function (this: any, b: string) { (opts.note ?? (this.notes = [])).push?.(b) },
    confirm: async () => (confirm.length ? Boolean(confirm.shift()) : true),
    select: async () => (select.length ? select.shift() : ''),
    text: async () => '',
  } as any
}
const BYTES = Buffer.from('VALID') as any // stands in for ValidatedCaBytes in unit tests

it('alreadyValidated + keep → pinned, gate note shown', async () => {
  const notes: string[] = []
  const prompter = { note: async (b: string) => { notes.push(b) }, confirm: async () => true, select: async () => '', text: async () => '' } as any
  const d = await reviewExistingTrust({
    prompter, probe: {} as any, host: 'h', port: 443,
    current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
  })
  expect(d).toEqual({ kind: 'pinned', caPath: expect.stringContaining('ca.pem'), caBytes: BYTES })
  expect(notes.join('\n')).toMatch(/Verification by CA file/)
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

- [ ] **Step 1: Failing tests** — add to `tests/unit/setup-trust.test.ts` (one canonical test shown; add the full matrix in Step listing below):

```ts
it('change → insecure → kind:insecure', async () => {
  const prompter = {
    note: async () => {}, confirm: async () => true,
    select: async () => 'insecure', text: async () => '',
  } as any
  const d = await reviewExistingTrust({
    prompter, probe: {} as any, host: 'h', port: 443,
    current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
  })
  // keep-confirm default true would keep; force change by returning false from confirm:
  // (use a confirm queue: first confirm = keep? → false)
  expect(d).toEqual({ kind: 'insecure' })
})
```

  **Full matrix to add** (each: stubbed prompter + probe; assert decision + that the gate note rendered; assert `download` never referenced — there is none here):
  - `insecure account → keep` → `current:{tlsVerify:false}`, confirm `[true]` → `{kind:'insecure'}`; note matches `/disabled \(insecure\)/`.
  - `insecure account → change → use-file` → confirm `[false]`, select `['use-file']`, probe stub `validateCaAgainstServer→ok`, text `['/new.pem']` → `{kind:'pinned', caPath:/new.pem/}`.
  - `pinned valid → change → use-file` → confirm `[false]`, select `['use-file']` → `{kind:'pinned'}` new path.
  - `pinned valid → change → insecure` → confirm `[false]`, select `['insecure']`, insecure-confirm `[true]` → `{kind:'insecure'}`.
  - `pinned valid → change → insecure declined` → insecure-confirm `[false]` → throws.
  - `pinned valid → change → re-probe → trusted` → select `['re-probe']`, probe stub `probeTls→{reachable:true,caUntrusted:false}` → `{kind:'system'}`.
  - `pinned valid → change → re-probe → still untrusted → use-file` → probe stub `probeTls→{reachable:true,caUntrusted:true}`, nested select `['use-file']` + validate ok → `{kind:'pinned'}`.
  - `pinned valid → change → abort` → select `['abort']` → throws `/cancelled/`.
  - `pinned valid → change → empty select` → select `[]` (drained → '') → throws `/cancelled/` (NOT use-file).

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

- [ ] **Step 1: Failing tests** — add to `tests/unit/setup-trust.test.ts` (stubbed probe):
  - `CLI valid → keep` → probe `validateCaAgainstServer→{ok:true, caBytes:BYTES}`, file readable (use a real tmp PEM), confirm `[true]` → `{kind:'pinned', caBytes:BYTES}`.
  - `CLI mismatch → change menu` → `validateCaAgainstServer→{ok:false, kind:'mismatch', error:'e', serverCert:{...}}`, select `['use-file']` → `{kind:'pinned'}`; assert a note matched `/no longer validates/`.
  - `CLI unreadable → change menu` → caPath points at a non-existent file → assert note `/missing or unreadable/`, select `['use-file']` → `{kind:'pinned'}`.
  - `CLI unreachable → lenient keep` → `validateCaAgainstServer→{ok:false, kind:'unreachable', error:'e'}` → `{kind:'pinned', caPath, caBytes:<stored bytes>}`; assert note `/keeping the stored CA WITHOUT re-validation/`.

```ts
it('CLI unreachable during re-validation → lenient keep with warning', async () => {
  const tmp = join(mkdtempSync(join(tmpdir(),'st-')), 'ca.pem'); writeFileSync(tmp, 'PEMBYTES')
  const notes: string[] = []
  const prompter = { note: async (b: string) => { notes.push(b) }, confirm: async () => true, select: async () => '', text: async () => '' } as any
  const probe = { validateCaAgainstServer: async () => ({ ok: false, kind: 'unreachable', error: 'ECONNREFUSED' }) } as any
  const d = await reviewExistingTrust({ prompter, probe, host: 'h', port: 443, current: { caPath: tmp }, locale: 'en' })
  expect(d.kind).toBe('pinned')
  expect(Buffer.from((d as any).caBytes).toString()).toBe('PEMBYTES')
  expect(notes.join('\n')).toMatch(/WITHOUT re-validation/)
})
```

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

- [ ] **Step 1: Update the changed test + add new ones** (RED). In `setup-wizard-trust.test.ts`:
  - Rename `'silent happy …'` → `'re-run: valid CA → gate → keep preserves caPath'`; body keeps cfg `{useTls:true, caPath: ca-valid.pem}`, prompter `makeFakePrompter({ confirmResponses:[true] })`; capture notes (wrap `prompter.note`) and assert one matches `/Текущая настройка TLS/` (locale pinned ru); assert caPath preserved, `download()` not called, OAuth got the bytes.
  - Add (cfg `{useTls:true, caPath: ca-valid.pem}`, server `ca-valid`):
    - keep → as above.
    - change→use-file: `confirmResponses:[false]`, `selectResponses:['use-file']`, `textResponses:[ca-valid.pem]` → caPath = file, download not called.
    - change→insecure: `confirmResponses:[false,true]` (gate=change, insecure-confirm=yes), `selectResponses:['insecure']` → `tlsVerify:false`, **caPath undefined** in saved cfg, OAuth `tlsVerify:false`+no ca.
    - change→re-probe→system: needs stubbed probe → covered in unit (Task 5/6); here assert via cfg `{caPath}` + `selectResponses:['re-probe']` only if a trusted outcome is reachable — otherwise OMIT and rely on the unit test (document in the test comment).
    - change→cancel: `confirmResponses:[false]`, `selectResponses:['abort']` → rejects.
  - Insecure account (cfg `{useTls:true, tlsVerify:false}`, NO env):
    - keep: `confirmResponses:[true]` → `tlsVerify:false` preserved, assert `download` & probe untouched (one trust prompt). Assert the insecure note rendered.
    - change→use-file: `confirmResponses:[false]`, `selectResponses:['use-file']`, `textResponses:[ca-valid.pem]` → caPath set, tlsVerify cleared.

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

- [ ] **Step 1: Rewrite `:762` + add CLI tests** (RED). In `bin-trueconf-setup.test.ts`:
  - Rewrite `'skip-probe path preserves existing cfg.caPath…'` → `'re-run: re-validates and keeps stored caPath'`: probeModule stub now provides `validateCaAgainstServer: async () => ({ ok:true, caBytes: <bytes> })`, `parseCertFromPem`, and `probeTls` (may still be called by reviewExistingTrust's re-probe only on change — keep the keep path so probeTls isn't needed, or provide a benign `probeTls`); prompter `confirmResponses:[true]`; assert caPath preserved into saved cfg + OAuth bytes.
  - Add: re-run change→use-file → `confirmResponses:[false]`, `selectResponses:['use-file']`, `textResponses:[validCa]`, stub `validateCaAgainstServer→ok` → saved caPath = new file.
  - Add: re-run change→insecure → `confirmResponses:[false,true]`, `selectResponses:['insecure']` → saved `tlsVerify:false`, no caPath.
  - Add (§1.1 regression): re-run insecure account → cfg `{useTls:true, port, tlsVerify:false}`, `confirmResponses:[true]` → saved `tlsVerify:false` preserved (assert `written.channels.trueconf.tlsVerify === false`).
  - Add: re-run stored caPath missing → cfg `{useTls:true, port, caPath:'/nope.pem'}`, `selectResponses:['abort']` → rejects, and a note matched `/missing or unreadable/`.

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run tests/integration/bin-trueconf-setup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire CLI** in `src/setup-shared.ts`:
  - Add import: `import { resolveAbsPath, reviewExistingTrust, type ProbeModule as TrustProbe } from './setup-trust'`.
  - Widen the `tcFields` inline type (:429-436) with `tlsVerify?: boolean`. In `runWizardAndFinalize`, pass `tcFields.tlsVerify` to `promptProbePreview` (add the 7th arg before `t, locale`).
  - Change `promptProbePreview` signature to add `currentTlsVerify: boolean | undefined`. Replace the short-circuit body (:161-183):

```ts
  if (currentUseTls !== undefined && currentPort !== undefined) {
    const hasTrust = (currentCaPath !== undefined) || (currentTlsVerify === false)
    if (currentUseTls !== false && hasTrust) {
      const decision = await reviewExistingTrust({
        prompter, probe: probeModule as unknown as TrustProbe, host: serverUrl, port: currentPort,
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

- **Spec coverage:** §3 decision tree → Tasks 4-8; §4 architecture (setup-trust + integration) → Tasks 2-8; §5 i18n → Task 1; §6 invariants (TOCTOU, lenient-no-brand, clearFields) → Tasks 6/7; §7 tests (2 changed + matrix + unit) → Tasks 7/8 + 4-6; §8 risks → covered in test matrix. CLI mismatch/missing-via-change-menu (§3.A v2.1) → Task 6.
- **Type consistency:** `TrustDecision`/`ReviewExistingTrustArgs`/`ProbeModule` defined Task 3-4, consumed identically Tasks 5-8. `reviewExistingTrust` signature stable across callers.
- **Placeholder scan:** the only deliberate intermediate placeholder is the Task-4 `changeMenu` throw, explicitly replaced in Task 5 (RED→GREEN sequencing, not a plan gap).
