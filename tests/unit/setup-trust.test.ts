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
