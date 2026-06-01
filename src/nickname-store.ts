import { readFileSync } from 'node:fs'
import { saveJsonFile } from 'openclaw/plugin-sdk/json-store'
import type { Logger } from './types'
import { matchesAnyNickname, normalizeNickname } from './nickname-match'

const MIN_LEN = 3
const MAX = 50

// Ultra-generic words a single group member could otherwise weaponize into a
// global activation trigger (the store is global — any group can add, every
// group is affected). Rejected on add and filtered on load. Compared against
// the normalized (lowercased) form. Conservative on purpose — only words no one
// would set as a distinctive bot nickname.
const RESERVED = new Set([
  'да', 'нет', 'неа', 'ок', 'окей', 'ага', 'угу', 'угум', 'эй', 'ау', 'ну', 'бот', 'хай', 'йо',
])

type Data = { nicknames: string[] }

// Closed outcome of add(): the tool layer switches on it exhaustively and tells
// the user the truth — including 'persist_failed', when the name was added to
// the in-memory list but the disk write threw, so it will be lost on restart.
export type NicknameAddResult =
  | { status: 'added' }
  | { status: 'exists' }
  | { status: 'too_short' }
  | { status: 'reserved' }
  | { status: 'cap' }
  | { status: 'persist_failed' }

export interface NicknameStore {
  list(): string[]
  matches(text: string): boolean
  add(name: string): NicknameAddResult
  remove(name: string): boolean
}

// Global, flat, disk-backed list of bot nicknames. The list is global (one set
// per bot) — no chatId — because activation runs in the channel layer before
// the agent, and this bot lives in a single session where the tool layer cannot
// see the originating chat (see spec "Почему не пер-чат"). Reads parse the file
// directly so a corrupt file is observable (the SDK json-store hides
// missing-vs-corrupt behind a single undefined); writes go through the SDK
// saveJsonFile (it creates the dir and sets perms). Both load and persist log
// failures via the optional logger — a silent reset or a swallowed write, with
// the tool still reporting success, is the worst failure mode for this feature.
export function createNicknameStore(filePath: string, logger: Logger | null = null): NicknameStore {
  let names: string[] = loadNicknames(filePath, logger)

  const persist = (): boolean => {
    try {
      saveJsonFile(filePath, { nicknames: names } satisfies Data)
      return true
    } catch (err) {
      logger?.error(
        `[trueconf] nickname store: failed to persist ${filePath}: ${err instanceof Error ? err.message : String(err)} — in-memory list will be lost on restart`,
      )
      return false
    }
  }

  return {
    list: () => [...names],
    matches: (text) => matchesAnyNickname(text, names),
    add: (name) => {
      const n = normalizeNickname(name)
      if (n.length < MIN_LEN) return { status: 'too_short' }
      if (RESERVED.has(n)) return { status: 'reserved' }
      if (names.includes(n)) return { status: 'exists' }
      if (names.length >= MAX) return { status: 'cap' }
      names = [...names, n]
      return persist() ? { status: 'added' } : { status: 'persist_failed' }
    },
    remove: (name) => {
      const n = normalizeNickname(name)
      const i = names.indexOf(n)
      if (i < 0) return false
      names = names.filter((_, j) => j !== i)
      persist()
      return true
    },
  }
}

// Read + parse the persisted list, re-applying the same normalize/dedupe/floor/
// cap invariants as add() so a hand-edited or older-format file cannot smuggle
// in non-canonical or over-cap entries. A missing file is the normal first-run
// case (silent); a present-but-unreadable file or non-JSON / unexpected-shape
// content is logged rather than silently swallowed.
function loadNicknames(filePath: string, logger: Logger | null): string[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger?.warn(
        `[trueconf] nickname store: cannot read ${filePath} (${err instanceof Error ? err.message : String(err)}); starting empty`,
      )
    }
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger?.error(
      `[trueconf] nickname store: ${filePath} is not valid JSON (${err instanceof Error ? err.message : String(err)}); starting empty`,
    )
    return []
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Data).nicknames)) {
    logger?.warn(`[trueconf] nickname store: ${filePath} has unexpected shape; starting empty`)
    return []
  }

  const names: string[] = []
  const seen = new Set<string>()
  for (const item of (parsed as Data).nicknames) {
    if (typeof item !== 'string') continue
    const n = normalizeNickname(item)
    if (n.length < MIN_LEN || RESERVED.has(n) || seen.has(n)) continue
    seen.add(n)
    names.push(n)
    if (names.length >= MAX) break
  }
  return names
}
