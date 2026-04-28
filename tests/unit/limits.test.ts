import { describe, expect, it, vi } from 'vitest'
import {
  CAPTION_LIMIT,
  FileUploadLimits,
  TEXT_LIMIT,
  bytesToMB,
  checkTextLength,
  normalizeExtension,
  splitTextForSending,
} from '../../src/limits'

describe('constants', () => {
  it('TEXT_LIMIT and CAPTION_LIMIT are 4096', () => {
    expect(TEXT_LIMIT).toBe(4096)
    expect(CAPTION_LIMIT).toBe(4096)
  })
})

describe('checkTextLength', () => {
  it('empty string is ok', () => {
    expect(checkTextLength('')).toEqual({ ok: true })
  })

  it('exactly limit code-points is ok', () => {
    expect(checkTextLength('x'.repeat(4096))).toEqual({ ok: true })
  })

  it('one code-point over limit fails with codePoints + limit', () => {
    expect(checkTextLength('x'.repeat(4097))).toEqual({ ok: false, codePoints: 4097, limit: 4096 })
  })

  it('counts astral-plane chars as one code-point each (parity with Python visible_len)', () => {
    // U+1F600 is one code-point but two UTF-16 code units.
    // `.length` would count 4096 emoji as 8192 — code-point count via `[...]` keeps it at 4096.
    expect(checkTextLength('\u{1F600}'.repeat(4096))).toEqual({ ok: true })
    const result = checkTextLength('\u{1F600}'.repeat(4097))
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.codePoints).toBe(4097)
      expect(result.limit).toBe(4096)
    }
  })

  it('respects custom limit', () => {
    expect(checkTextLength('hello', 5)).toEqual({ ok: true })
    expect(checkTextLength('hello!', 5)).toEqual({ ok: false, codePoints: 6, limit: 5 })
  })
})

describe('splitTextForSending', () => {
  it('returns [text] when text is empty', () => {
    expect(splitTextForSending('')).toEqual([''])
  })

  it('returns [text] when within limit', () => {
    expect(splitTextForSending('hello world')).toEqual(['hello world'])
  })

  it('boundary: text exactly at limit returns single chunk', () => {
    const text = 'x'.repeat(4096)
    expect(splitTextForSending(text)).toEqual([text])
  })

  it('splits on paragraph boundaries when paragraphs fit', () => {
    const para1 = 'a'.repeat(3000)
    const para2 = 'b'.repeat(3000)
    const text = `${para1}\n\n${para2}`
    const chunks = splitTextForSending(text)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) expect([...c].length).toBeLessThanOrEqual(4096)
    // Re-joining recovers the paragraphs.
    expect(chunks.join('\n\n')).toBe(text)
  })

  it('three paragraphs fitting under limit return single chunk', () => {
    const text = 'a'.repeat(1000) + '\n\n' + 'b'.repeat(1000) + '\n\n' + 'c'.repeat(1000)
    expect(splitTextForSending(text)).toEqual([text])
  })

  it('falls through to sentence split when one paragraph exceeds limit', () => {
    // 4 sentences of 1500 chars each → no paragraph break, but sentence boundaries.
    const sentences = ['a'.repeat(1500), 'b'.repeat(1500), 'c'.repeat(1500), 'd'.repeat(1500)]
    const text = sentences.join('. ') + '.'
    const chunks = splitTextForSending(text)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) expect([...c].length).toBeLessThanOrEqual(4096)
    // Concatenation should preserve all original chars.
    expect(chunks.join('').length).toBeGreaterThanOrEqual(text.length - chunks.length)
  })

  it('hard-cuts on code-point boundary when no separator fits', () => {
    // No paragraph, no sentence terminator — just a wall of one char.
    const text = 'x'.repeat(10_000)
    const chunks = splitTextForSending(text)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const c of chunks) expect([...c].length).toBeLessThanOrEqual(4096)
    expect(chunks.join('')).toBe(text)
  })

  it('hard-cut preserves astral code-point boundaries (no orphaned surrogates)', () => {
    const text = '\u{1F600}'.repeat(5000)
    const chunks = splitTextForSending(text)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) {
      // Code-point safe slice means every chunk re-codepoints to same `[...c].length`.
      expect([...c].length).toBeLessThanOrEqual(4096)
      // No lone surrogates: every char is the full emoji.
      for (const cp of c) expect(cp).toBe('\u{1F600}')
    }
    expect(chunks.join('')).toBe(text)
  })

  it('preserves a markdown code block as a single chunk when block fits within limit', () => {
    const lead = 'a'.repeat(500)
    const block = '```py\n' + 'print("hello")\n'.repeat(100) + '```'
    const tail = 'b'.repeat(500)
    const text = `${lead}\n\n${block}\n\n${tail}`
    expect([...block].length).toBeLessThan(4096)
    const chunks = splitTextForSending(text)
    // The fenced block should appear intact in exactly one chunk.
    const containing = chunks.filter((c) => c.includes(block))
    expect(containing.length).toBe(1)
  })
})

describe('normalizeExtension', () => {
  it('lowercases and strips dot', () => {
    expect(normalizeExtension('report.PDF')).toBe('pdf')
  })

  it('takes the last segment in multi-dot names', () => {
    expect(normalizeExtension('archive.tar.gz')).toBe('gz')
  })

  it('returns empty string when no extension', () => {
    expect(normalizeExtension('noext')).toBe('')
  })

  it('treats leading-dot file as the extension', () => {
    expect(normalizeExtension('.dotfile')).toBe('dotfile')
  })

  it('returns empty string for trailing dot', () => {
    expect(normalizeExtension('file.')).toBe('')
  })
})

describe('FileUploadLimits.getMaxBytes', () => {
  it('returns staticMaxBytes before any server update', () => {
    const limits = new FileUploadLimits(1234)
    expect(limits.getMaxBytes()).toBe(1234)
  })

  it('uses pushed integer maxSize', () => {
    const limits = new FileUploadLimits(1234)
    limits.updateFromServer({ maxSize: 1000, extensions: null })
    expect(limits.getMaxBytes()).toBe(1000)
  })

  it('treats maxSize=null as unlimited (Number.MAX_SAFE_INTEGER)', () => {
    const limits = new FileUploadLimits(1234)
    limits.updateFromServer({ maxSize: null, extensions: null })
    expect(limits.getMaxBytes()).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('FileUploadLimits.updateFromServer corrupt payloads', () => {
  it('non-int maxSize → warn + no-op', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const limits = new FileUploadLimits(500, logger)
    limits.updateFromServer({ maxSize: 'lots', extensions: null })
    expect(logger.warn).toHaveBeenCalled()
    // No state change.
    expect(limits.getMaxBytes()).toBe(500)
  })

  it('non-array extensions.list → warn + no-op', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const limits = new FileUploadLimits(500, logger)
    limits.updateFromServer({ maxSize: 100, extensions: { mode: 'allow', list: 'pdf' } })
    expect(logger.warn).toHaveBeenCalled()
    // Whole payload rejected (atomic) — static cap still in effect.
    expect(limits.getMaxBytes()).toBe(500)
  })

  it('invalid extensions.mode → warn + no-op', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const limits = new FileUploadLimits(500, logger)
    limits.updateFromServer({ maxSize: 100, extensions: { mode: 'wat', list: ['pdf'] } })
    expect(logger.warn).toHaveBeenCalled()
    expect(limits.getMaxBytes()).toBe(500)
  })

  it('non-string element in extensions.list → warn + no-op', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const limits = new FileUploadLimits(500, logger)
    limits.updateFromServer({ maxSize: 100, extensions: { mode: 'allow', list: ['pdf', 42] } })
    expect(logger.warn).toHaveBeenCalled()
    expect(limits.getMaxBytes()).toBe(500)
  })
})

describe('FileUploadLimits.validateFile', () => {
  it('ok when file is under cap and no extension filter', () => {
    const limits = new FileUploadLimits(10_000)
    expect(limits.validateFile('x.pdf', 100)).toEqual({ ok: true })
  })

  it('fails too_large when sizeBytes > getMaxBytes', () => {
    const limits = new FileUploadLimits(10_000)
    const result = limits.validateFile('big.pdf', 999_999_999)
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.reason).toBe('too_large')
  })

  it('fails extension_blocked when mode=block and extension is in list', () => {
    const limits = new FileUploadLimits(10_000)
    limits.updateFromServer({ maxSize: 10_000, extensions: { mode: 'block', list: ['exe'] } })
    const result = limits.validateFile('blocked.exe', 100)
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.reason).toBe('extension_blocked')
  })

  it('passes empty extension when mode=block', () => {
    const limits = new FileUploadLimits(10_000)
    limits.updateFromServer({ maxSize: 10_000, extensions: { mode: 'block', list: ['exe'] } })
    expect(limits.validateFile('noext', 100)).toEqual({ ok: true })
  })

  it('passes when mode=allow and extension is in list', () => {
    const limits = new FileUploadLimits(10_000)
    limits.updateFromServer({ maxSize: 10_000, extensions: { mode: 'allow', list: ['pdf', 'png'] } })
    expect(limits.validateFile('allowed.pdf', 100)).toEqual({ ok: true })
  })

  it('fails extension_blocked when mode=allow and extension is missing', () => {
    const limits = new FileUploadLimits(10_000)
    limits.updateFromServer({ maxSize: 10_000, extensions: { mode: 'allow', list: ['pdf'] } })
    const result = limits.validateFile('foo.exe', 100)
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.reason).toBe('extension_blocked')
  })

  it('mode=allow blocks empty extension', () => {
    const limits = new FileUploadLimits(10_000)
    limits.updateFromServer({ maxSize: 10_000, extensions: { mode: 'allow', list: ['pdf'] } })
    const result = limits.validateFile('noext', 100)
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.reason).toBe('extension_blocked')
  })

  it('case-insensitive extension comparison', () => {
    const limits = new FileUploadLimits(10_000)
    limits.updateFromServer({ maxSize: 10_000, extensions: { mode: 'allow', list: ['PDF'] } })
    expect(limits.validateFile('report.pdf', 100)).toEqual({ ok: true })
  })

  it('size check runs before extension check', () => {
    const limits = new FileUploadLimits(100)
    limits.updateFromServer({ maxSize: 100, extensions: { mode: 'block', list: ['exe'] } })
    const result = limits.validateFile('big.exe', 9999)
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.reason).toBe('too_large')
  })
})

describe('bytesToMB', () => {
  it('binary MB ceil', () => {
    expect(bytesToMB(50_000_000)).toBe(48)
  })

  it('exact MiB stays exact', () => {
    expect(bytesToMB(1024 * 1024)).toBe(1)
    expect(bytesToMB(2 * 1024 * 1024)).toBe(2)
  })

  it('one byte over rounds up', () => {
    expect(bytesToMB(1024 * 1024 + 1)).toBe(2)
  })
})
