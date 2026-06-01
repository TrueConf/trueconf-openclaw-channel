// Canonical form for storing and comparing nicknames: trimmed, lowercased,
// inner whitespace collapsed to single spaces. Comparison is always done on
// normalized values so 'БД   Бот' and 'бд бот' are the same nickname.
export function normalizeNickname(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Whole-word match anywhere in the text. JS `\b` is ASCII-only, so Cyrillic
// nicknames need Unicode-aware boundaries: lookbehind/lookahead asserting the
// adjacent char is not a letter or number (\p{L}\p{N}, requires the `u` flag).
// Multiword nicknames tolerate variable inner whitespace via `\s+`. The `i` flag
// is load-bearing: only the stored nicknames are lowercased (normalizeNickname),
// the haystack is the raw message text — so case-insensitivity must come from
// the regex, not from pre-lowercasing both sides.
function buildNicknameRegExp(normNick: string): RegExp {
  const body = normNick.split(' ').map(escapeRegExp).join('\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu')
}

export function matchesAnyNickname(text: string, normalizedNicknames: string[]): boolean {
  if (!text || normalizedNicknames.length === 0) return false
  for (const nick of normalizedNicknames) {
    if (nick && buildNicknameRegExp(nick).test(text)) return true
  }
  return false
}
