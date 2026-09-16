import { TEXT_LIMIT, splitTextForSending } from './limits'

// TrueConf html mode renders only <b>, <i>, <u>, <s>, <a> and collapses raw
// newlines, so every line break has to travel as <br>.

const BR_RE = /(?:<|&lt;)\s*\/?\s*br\s*\/?\s*(?:>|&gt;)/gi
const FENCE_RE = /^\s*```/
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/
const CODE_SPAN_RE = /`([^`\n]+)`/g
const ALLOWED_TAG_RE = /<(\/?)(b|i|u|s)>/gi
const AUTOLINK_RE = /<((?:https?|mailto):[^\s<>]+)>/gi
const LINK_RE = /\[([^\]\n]+)\]\(\s*<?((?:https?:\/\/|mailto:)[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/gi
const AMP_RE = /&(?!(?:[a-z][a-z0-9]{1,31}|#\d{1,7}|#x[0-9a-f]{1,6});)/gi
const NBSP = '\u00a0'
const RULE = '──────────'

// Rendered spans hide behind private-use code points so the emphasis pass
// cannot rewrite code, URLs, or tags. Input copies of these points are dropped.
const SLOT_MARK_RE = /[\ue000\ue001]/g
const SLOT_RE = /\ue000(\d+)\ue001/g

function escapeHtml(text: string): string {
  return text.replace(AMP_RE, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderEmphasis(text: string): string {
  return text
    .replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '<b>$1</b>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/(?<![\p{L}\p{N}*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\p{L}\p{N}*])/gu, '<i>$1</i>')
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, '<i>$1</i>')
}

function renderInline(text: string): string {
  const slots: string[] = []
  const hide = (html: string): string => `\ue000${slots.push(html) - 1}\ue001`
  const reveal = (html: string): string => html.replace(SLOT_RE, (_, i: string) => slots[Number(i)] ?? '')
  const hidden = text
    .replace(CODE_SPAN_RE, (_, code: string) => hide(escapeHtml(code)))
    .replace(ALLOWED_TAG_RE, (_, close: string, tag: string) => hide(`<${close}${tag.toLowerCase()}>`))
    .replace(AUTOLINK_RE, (_, url: string) => hide(escapeHtml(url)))
    .replace(LINK_RE, (_, label: string, url: string) =>
      hide(`<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${reveal(renderEmphasis(escapeHtml(label)))}</a>`),
    )
  return reveal(renderEmphasis(escapeHtml(hidden)))
}

function indent(whitespace: string): string {
  return NBSP.repeat(whitespace.replace(/\t/g, '    ').length)
}

function renderLine(line: string): string {
  const heading = HEADING_RE.exec(line)
  if (heading) return `<b>${renderInline(heading[1])}</b>`
  if (RULE_RE.test(line)) return RULE
  const bullet = BULLET_RE.exec(line)
  if (bullet) {
    const depth = bullet[1]
    return `${indent(depth)}${depth.length > 1 ? '◦' : '•'} ${renderInline(bullet[2])}`
  }
  const ordered = ORDERED_RE.exec(line)
  if (ordered) return `${indent(ordered[1])}${ordered[2]}. ${renderInline(ordered[3])}`
  const quote = QUOTE_RE.exec(line)
  if (quote) return `<i>${renderInline(quote[1])}</i>`
  return renderInline(line.trim())
}

function renderTableRow(line: string): string {
  return line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
    .map(renderInline)
    .join(' — ')
}

function renderBlocks(lines: string[]): string[] {
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE_RE.test(line)) {
      inFence = !inFence
    } else if (inFence) {
      out.push(escapeHtml(line).replace(/^\s+/, indent))
    } else if (TABLE_ROW_RE.test(line) && TABLE_SEPARATOR_RE.test(lines[i + 1] ?? '')) {
      out.push(`<b>${renderTableRow(line)}</b>`)
      i += 1
      while (TABLE_ROW_RE.test(lines[i + 1] ?? '')) {
        i += 1
        out.push(`• ${renderTableRow(lines[i])}`)
      }
    } else {
      out.push(renderLine(line))
    }
  }
  return out
}

function joinWithBreaks(lines: string[]): string {
  const kept: string[] = []
  for (const line of lines) {
    const blank = line.trim() === ''
    if (blank && (kept.length === 0 || kept[kept.length - 1] === '')) continue
    kept.push(blank ? '' : line)
  }
  while (kept[kept.length - 1] === '') kept.pop()
  return kept.join('<br>')
}

export function markdownToTrueconfHtml(markdown: string): string {
  const lines = markdown.replace(SLOT_MARK_RE, '').replace(/\r\n?/g, '\n').replace(BR_RE, '\n').split('\n')
  return joinWithBreaks(renderBlocks(lines))
}

// Splits on markdown first so no chunk cuts through a tag, then re-splits any
// chunk whose html outgrows `limit` in proportion to the overshoot.
export function renderForSending(markdown: string, limit: number = TEXT_LIMIT): string[] {
  const render = (text: string, splitAt: number): string[] =>
    splitTextForSending(text, splitAt).flatMap((chunk) => {
      const html = markdownToTrueconfHtml(chunk)
      const size = [...html].length
      if (size <= limit) return [html]
      return render(chunk, Math.max(1, Math.floor(([...chunk].length * limit) / size)))
    })
  return render(markdown, limit)
}
