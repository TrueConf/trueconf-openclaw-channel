import type { Logger } from './types'

export const TEXT_LIMIT = 4096
export const CAPTION_LIMIT = 4096

export interface ValidationOk { ok: true }
export interface ValidationFail {
  ok: false
  reason: 'too_large' | 'extension_blocked'
  detail: string
}
export type ValidationResult = ValidationOk | ValidationFail

export type CheckTextLengthResult =
  | { ok: true }
  | { ok: false; codePoints: number; limit: number }

/**
 * Code-point length check (parity with Python `visible_len`).
 * `[...text].length` walks the string by Unicode code points, NOT UTF-16 code units —
 * one astral-plane char (e.g. emoji) counts as 1 here vs 2 with `.length`.
 */
export function checkTextLength(text: string, limit: number = TEXT_LIMIT): CheckTextLengthResult {
  const codePoints = [...text].length
  if (codePoints <= limit) return { ok: true }
  return { ok: false, codePoints, limit }
}

const SENTENCE_TERMINATORS = ['. ', '! ', '? ', '\n']

/**
 * Auto-split for outbound text. Order:
 *   1. Paragraph boundaries (`\n\n`)
 *   2. Sentence boundaries (`. `, `! `, `? `, `\n`)
 *   3. Hard cut on a code-point boundary
 *
 * Markdown fenced code blocks (```...```) are kept intact when they fit within `limit`.
 *
 * Always returns at least one chunk; for empty input returns `[""]`.
 */
export function splitTextForSending(text: string, limit: number = TEXT_LIMIT): string[] {
  if ([...text].length <= limit) return [text]

  // Phase 1: extract fenced code blocks as atomic segments where possible.
  const segments = segmentByCodeBlocks(text)
  const out: string[] = []
  let buf = ''

  const flush = () => {
    if (buf.length > 0) {
      out.push(buf)
      buf = ''
    }
  }

  for (const seg of segments) {
    if (seg.atomic && [...seg.text].length <= limit) {
      // Atomic segment fits as-is.
      if ([...buf].length + [...seg.text].length <= limit) {
        buf += seg.text
      } else {
        flush()
        buf = seg.text
      }
      continue
    }

    // Non-atomic segment: paragraph → sentence → hard cut.
    const sub = splitFreeform(seg.text, limit)
    for (let i = 0; i < sub.length; i++) {
      const piece = sub[i] ?? ''
      if ([...buf].length + [...piece].length <= limit) {
        buf += piece
      } else {
        flush()
        buf = piece
      }
    }
  }
  flush()

  return out.length > 0 ? out : [text]
}

interface Segment {
  text: string
  atomic: boolean // true if this is a fenced code block to be kept intact when possible
}

/**
 * Split text into segments, marking fenced code blocks (```...```) as atomic.
 * The fenced block must start at the beginning of a line (or text start) — a triple backtick
 * mid-paragraph is not treated as a code fence.
 */
function segmentByCodeBlocks(text: string): Segment[] {
  const segments: Segment[] = []
  let i = 0
  while (i < text.length) {
    const fenceStart = findFenceStart(text, i)
    if (fenceStart < 0) {
      segments.push({ text: text.slice(i), atomic: false })
      break
    }
    if (fenceStart > i) {
      segments.push({ text: text.slice(i, fenceStart), atomic: false })
    }
    const fenceEnd = findFenceEnd(text, fenceStart + 3)
    if (fenceEnd < 0) {
      // Unterminated fence — treat the rest as freeform.
      segments.push({ text: text.slice(fenceStart), atomic: false })
      break
    }
    segments.push({ text: text.slice(fenceStart, fenceEnd + 3), atomic: true })
    i = fenceEnd + 3
  }
  return segments
}

function findFenceStart(text: string, from: number): number {
  let idx = from
  while (idx < text.length) {
    const next = text.indexOf('```', idx)
    if (next < 0) return -1
    if (next === 0 || text[next - 1] === '\n') return next
    idx = next + 3
  }
  return -1
}

function findFenceEnd(text: string, from: number): number {
  let idx = from
  while (idx < text.length) {
    const next = text.indexOf('```', idx)
    if (next < 0) return -1
    // Closing fence ends at end-of-string or is followed by `\n`.
    if (next + 3 === text.length || text[next + 3] === '\n') return next
    idx = next + 3
  }
  return -1
}

/**
 * Split a non-code-block segment by paragraph → sentence → hard-cut.
 */
function splitFreeform(text: string, limit: number): string[] {
  if ([...text].length <= limit) return [text]

  // Phase 2a: paragraph split.
  if (text.includes('\n\n')) {
    const paragraphs = text.split('\n\n')
    const out: string[] = []
    let buf = ''
    for (const p of paragraphs) {
      const candidate = buf ? buf + '\n\n' + p : p
      if ([...candidate].length <= limit) {
        buf = candidate
      } else {
        if (buf) {
          out.push(buf)
          buf = ''
        }
        if ([...p].length <= limit) {
          buf = p
        } else {
          out.push(...splitBySentence(p, limit))
        }
      }
    }
    if (buf) out.push(buf)
    return out
  }

  // Phase 2b: sentence split.
  return splitBySentence(text, limit)
}

function splitBySentence(text: string, limit: number): string[] {
  if ([...text].length <= limit) return [text]

  const pieces = splitOnTerminators(text)
  if (pieces.length === 1) return splitHardCut(text, limit)

  const out: string[] = []
  let buf = ''
  for (const piece of pieces) {
    if ([...piece].length > limit) {
      // Single sentence exceeds limit — flush buf, hard-cut this piece.
      if (buf) {
        out.push(buf)
        buf = ''
      }
      out.push(...splitHardCut(piece, limit))
      continue
    }
    const candidate = buf + piece
    if ([...candidate].length <= limit) {
      buf = candidate
    } else {
      if (buf) out.push(buf)
      buf = piece
    }
  }
  if (buf) out.push(buf)
  return out
}

/**
 * Split on sentence terminators (. ! ? followed by space, or \n) keeping the terminator
 * with the preceding sentence.
 */
function splitOnTerminators(text: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  while (i < text.length) {
    let matched = -1
    for (const t of SENTENCE_TERMINATORS) {
      if (text.startsWith(t, i)) {
        matched = t.length
        break
      }
    }
    if (matched > 0) {
      out.push(text.slice(start, i + matched))
      i += matched
      start = i
    } else {
      i++
    }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

/**
 * Hard cut on code-point boundaries. Iterates by code points (NOT UTF-16 units) so we never
 * leave a surrogate half behind.
 */
function splitHardCut(text: string, limit: number): string[] {
  const out: string[] = []
  const cps = [...text]
  for (let i = 0; i < cps.length; i += limit) {
    out.push(cps.slice(i, i + limit).join(''))
  }
  return out
}

/**
 * Extension extraction: lowercase, strip leading dots, take last dotted segment.
 *   "report.PDF" → "pdf"
 *   "archive.tar.gz" → "gz"
 *   "noext" → ""
 *   ".dotfile" → "dotfile"
 *   "file." → ""
 */
export function normalizeExtension(fileName: string): string {
  const stripped = stripLeadingDots(fileName)
  const dot = stripped.lastIndexOf('.')
  if (dot < 0) {
    // No dot remained after stripping leading dots:
    //   ".dotfile" → "dotfile" (whole stripped name is the extension)
    //   "noext"   → ""        (no extension)
    return fileName.startsWith('.') ? stripped.toLowerCase() : ''
  }
  return stripped.slice(dot + 1).toLowerCase()
}

function stripLeadingDots(s: string): string {
  let i = 0
  while (i < s.length && s[i] === '.') i++
  return s.slice(i)
}

/**
 * Binary-MB ceiling. Parity with Python's `actual_size / (1024 * 1024)` user-display.
 */
export function bytesToMB(bytes: number): number {
  return Math.ceil(bytes / (1024 * 1024))
}

interface ServerExtensionsPayload {
  mode: 'allow' | 'block'
  list: string[]
}

/**
 * Runtime-mutable per-account file upload limits. Server pushes `getFileUploadLimits`
 * (id matches Python `IncomingUpdateMethod.CHANGED_FILE_UPLOAD_LIMITS`) with payload:
 *   { maxSize: int | null, extensions: { mode: "allow" | "block", list: string[] } | null }
 * `null` means "limit disabled" (Python parity).
 *
 * Static fallback (`staticMaxBytes`) is used only until the first valid server push.
 * After a server push with `maxSize: null`, the limit is treated as unlimited — we do NOT
 * fall back to the static cap.
 */
export class FileUploadLimits {
  private maxSizeFromServer: number | null = null
  private hasServerMaxSize = false
  private filterMode: 'allow' | 'block' | null = null
  private extensionsSet: Set<string> | null = null
  private readonly staticMaxBytes: number
  private readonly logger?: Logger

  constructor(staticMaxBytes: number, logger?: Logger) {
    this.staticMaxBytes = staticMaxBytes
    this.logger = logger
  }

  /**
   * Validate + apply atomically. Corrupt payload → log warn + no-op (no partial state change).
   */
  updateFromServer(payload: Record<string, unknown>): void {
    const validatedMax = validateMaxSize(payload['maxSize'])
    if (!validatedMax.ok) {
      this.logger?.warn(`FileUploadLimits.updateFromServer: ${validatedMax.detail}`)
      return
    }
    const validatedExt = validateExtensions(payload['extensions'])
    if (!validatedExt.ok) {
      this.logger?.warn(`FileUploadLimits.updateFromServer: ${validatedExt.detail}`)
      return
    }

    this.maxSizeFromServer = validatedMax.value
    this.hasServerMaxSize = true
    if (validatedExt.value === null) {
      this.filterMode = null
      this.extensionsSet = null
    } else {
      this.filterMode = validatedExt.value.mode
      // List entries may arrive as "pdf" or ".PDF" — strip leading dots and lowercase to a
      // bare extension token so comparison against `normalizeExtension(fileName)` matches.
      this.extensionsSet = new Set(validatedExt.value.list.map((e) => stripLeadingDots(e).toLowerCase()))
    }
  }

  /**
   * Effective max-bytes limit:
   *   - server pushed maxSize=null → Number.MAX_SAFE_INTEGER (limit disabled)
   *   - server pushed integer → that integer
   *   - never pushed → staticMaxBytes
   */
  getMaxBytes(): number {
    if (!this.hasServerMaxSize) return this.staticMaxBytes
    if (this.maxSizeFromServer === null) return Number.MAX_SAFE_INTEGER
    return this.maxSizeFromServer
  }

  validateFile(fileName: string, sizeBytes: number): ValidationResult {
    const maxBytes = this.getMaxBytes()
    if (sizeBytes > maxBytes) {
      return {
        ok: false,
        reason: 'too_large',
        detail: `${sizeBytes} bytes > limit ${maxBytes} bytes`,
      }
    }

    if (this.filterMode === null || this.extensionsSet === null) {
      return { ok: true }
    }

    const ext = normalizeExtension(fileName)
    if (this.filterMode === 'allow') {
      // Empty extension always fails in allow-mode.
      if (ext === '' || !this.extensionsSet.has(ext)) {
        return {
          ok: false,
          reason: 'extension_blocked',
          detail: `extension '${ext}' not in allow-list`,
        }
      }
      return { ok: true }
    }

    // mode === 'block'. Empty extension passes (nothing to block).
    if (ext !== '' && this.extensionsSet.has(ext)) {
      return {
        ok: false,
        reason: 'extension_blocked',
        detail: `extension '${ext}' is in block-list`,
      }
    }
    return { ok: true }
  }
}

type ValidatedField<T> = { ok: true; value: T } | { ok: false; detail: string }

function validateMaxSize(raw: unknown): ValidatedField<number | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return { ok: false, detail: `maxSize must be int|null, got ${typeof raw}` }
  }
  return { ok: true, value: raw }
}

function validateExtensions(raw: unknown): ValidatedField<ServerExtensionsPayload | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'object') {
    return { ok: false, detail: `extensions must be object|null, got ${typeof raw}` }
  }
  const obj = raw as Record<string, unknown>
  const mode = obj['mode']
  if (mode !== 'allow' && mode !== 'block') {
    return { ok: false, detail: `extensions.mode must be 'allow'|'block', got ${String(mode)}` }
  }
  const list = obj['list']
  if (!Array.isArray(list)) {
    return { ok: false, detail: `extensions.list must be array, got ${typeof list}` }
  }
  for (const item of list) {
    if (typeof item !== 'string') {
      return { ok: false, detail: `extensions.list element must be string, got ${typeof item}` }
    }
  }
  return { ok: true, value: { mode, list: list as string[] } }
}
