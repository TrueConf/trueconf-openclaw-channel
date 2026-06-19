import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve as pathResolve, join } from 'node:path'
import { resolveAbsPath, shortFp, promptInsecureConfirm, reviewExistingTrust } from '../../src/setup-trust'

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

// readCaFileInteractive does a real readFileSync, so use-file paths in unit
// tests must point at an actual file (the plan's illustrative '/new.pem' would
// throw ENOENT). Create a throwaway PEM and return its absolute path.
function mkTmpPem(name = 'ca.pem', contents = 'PEMBYTES'): string {
  const p = join(mkdtempSync(join(tmpdir(), 'st-')), name)
  writeFileSync(p, contents)
  return p
}

describe('setup-trust primitives', () => {
  it('resolveAbsPath expands ~ and absolutises', () => {
    expect(resolveAbsPath('~/x')).toBe(pathResolve(homedir(), 'x'))
    expect(resolveAbsPath('rel')).toBe(pathResolve('rel'))
  })
  it('shortFp truncates long fingerprints', () => {
    expect(shortFp(null)).toBe('?')
    expect(shortFp('a'.repeat(40))).toMatch(/…$/)
  })

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
})

describe('reviewExistingTrust', () => {
  it('alreadyValidated + keep → pinned, gate note shown', async () => {
    const prompter = mkPrompter({ confirm: [true] })   // keep
    const d = await reviewExistingTrust({
      prompter, probe: {} as any, host: 'h', port: 443,
      current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
    })
    expect(d).toEqual({ kind: 'pinned', caPath: expect.stringContaining('ca.pem'), caBytes: BYTES })
    expect(prompter.notes.join('\n')).toMatch(/Verification by CA file/)
  })

  it('insecure account → keep → kind:insecure, gate note shown', async () => {
    const prompter = mkPrompter({ confirm: [true] })
    const d = await reviewExistingTrust({
      prompter, probe: mkProbe(), host: 'h', port: 443,
      current: { tlsVerify: false }, locale: 'en',
    })
    expect(d).toEqual({ kind: 'insecure' })
    expect(prompter.notes.join('\n')).toMatch(/disabled \(insecure\)/)
  })

  it('insecure account → change → use-file → kind:pinned', async () => {
    const newPem = mkTmpPem('new.pem')
    const prompter = mkPrompter({ confirm: [false], select: ['use-file'], text: [newPem] })
    const d = await reviewExistingTrust({
      prompter, probe: mkProbe(), host: 'h', port: 443,
      current: { tlsVerify: false }, locale: 'en',
    })
    expect(d).toEqual({ kind: 'pinned', caPath: expect.stringContaining('new.pem'), caBytes: Buffer.from('NEWCA') })
    expect(prompter.notes.join('\n')).toMatch(/disabled \(insecure\)/)
  })

  it('pinned valid → change → insecure (accepted) → kind:insecure', async () => {
    const prompter = mkPrompter({ confirm: [false, true], select: ['insecure'] })
    const d = await reviewExistingTrust({
      prompter, probe: mkProbe(), host: 'h', port: 443,
      current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
    })
    expect(d).toEqual({ kind: 'insecure' })
    expect(prompter.notes.join('\n')).toMatch(/Verification by CA file/)
  })

  it('pinned valid → change → use-file → kind:pinned (new path)', async () => {
    const newPem = mkTmpPem('new.pem')
    const prompter = mkPrompter({ confirm: [false], select: ['use-file'], text: [newPem] })
    const d = await reviewExistingTrust({
      prompter, probe: mkProbe(), host: 'h', port: 443,
      current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
    })
    expect(d).toEqual({ kind: 'pinned', caPath: expect.stringContaining('new.pem'), caBytes: Buffer.from('NEWCA') })
    expect(prompter.notes.join('\n')).toMatch(/Verification by CA file/)
  })

  it('pinned valid → change → insecure (declined) → rejects', async () => {
    const prompter = mkPrompter({ confirm: [false, false], select: ['insecure'] })
    await expect(reviewExistingTrust({
      prompter, probe: mkProbe(), host: 'h', port: 443,
      current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
    })).rejects.toThrow(/declined/)
    expect(prompter.notes.join('\n')).toMatch(/Verification by CA file/)
  })

  it('pinned valid → change → re-probe → server trusted → kind:system', async () => {
    const probeTls = vi.fn(async () => ({ reachable: true, useTls: true, port: 443, caUntrusted: false }))
    const prompter = mkPrompter({ confirm: [false], select: ['re-probe'] })
    const d = await reviewExistingTrust({
      prompter, probe: mkProbe({ probeTls }), host: 'h', port: 443,
      current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
    })
    expect(d).toEqual({ kind: 'system' })
    expect(probeTls).toHaveBeenCalled()
    expect(prompter.notes.join('\n')).toMatch(/Verification by CA file/)
  })

  it('pinned valid → change → re-probe → still untrusted → use-file → kind:pinned', async () => {
    const newPem = mkTmpPem('new.pem')
    const probeTls = vi.fn(async () => ({ reachable: true, useTls: true, port: 443, caUntrusted: true }))
    const prompter = mkPrompter({ confirm: [false], select: ['re-probe', 'use-file'], text: [newPem] })
    const d = await reviewExistingTrust({
      prompter, probe: mkProbe({ probeTls }), host: 'h', port: 443,
      current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
    })
    expect(d).toEqual({ kind: 'pinned', caPath: expect.stringContaining('new.pem'), caBytes: Buffer.from('NEWCA') })
    expect(probeTls).toHaveBeenCalled()
  })

  it('pinned valid → change → abort → rejects', async () => {
    const prompter = mkPrompter({ confirm: [false], select: ['abort'] })
    await expect(reviewExistingTrust({
      prompter, probe: mkProbe(), host: 'h', port: 443,
      current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
    })).rejects.toThrow(/cancelled/)
    expect(prompter.notes.join('\n')).toMatch(/Verification by CA file/)
  })

  it('pinned valid → change → empty select → rejects via changeMenu (no use-file fall-through)', async () => {
    const prompter = mkPrompter({ confirm: [false], select: [] })
    await expect(reviewExistingTrust({
      prompter, probe: mkProbe(), host: 'h', port: 443,
      current: { caPath: '/ca.pem' }, alreadyValidated: { caBytes: BYTES }, locale: 'en',
    })).rejects.toThrow(/Trust change cancelled/)
  })
})
