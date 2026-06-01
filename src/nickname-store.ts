import { loadJsonFile, saveJsonFile } from 'openclaw/plugin-sdk/json-store'
import { matchesAnyNickname, normalizeNickname } from './nickname-match'

const MIN_LEN = 2
const MAX = 50

type Data = { nicknames: string[] }

export interface NicknameStore {
  list(): string[]
  matches(text: string): boolean
  add(name: string): { ok: boolean; reason?: string }
  remove(name: string): boolean
}

// Global, flat, disk-backed list of bot nicknames. Synchronous (registerFull is
// sync) JSON read/write via the SDK json-store. The list is global (one set per
// bot) — no chatId — because activation runs in the channel layer before the
// agent, and this bot lives in a single session where the tool layer cannot see
// the originating chat (see spec "Почему не пер-чат").
export function createNicknameStore(filePath: string): NicknameStore {
  let names: string[] = []
  try {
    const loaded = loadJsonFile(filePath)
    if (loaded && typeof loaded === 'object' && Array.isArray((loaded as Data).nicknames)) {
      names = (loaded as Data).nicknames.filter((n): n is string => typeof n === 'string')
    }
  } catch {
    names = []
  }

  const persist = (): void => {
    try {
      saveJsonFile(filePath, { nicknames: names } satisfies Data)
    } catch {
      // best-effort: a failed write leaves the in-memory list authoritative
    }
  }

  return {
    list: () => [...names],
    matches: (text) => matchesAnyNickname(text, names),
    add: (name) => {
      const n = normalizeNickname(name)
      if (n.length < MIN_LEN) return { ok: false, reason: 'too_short' }
      if (names.includes(n)) return { ok: true }
      if (names.length >= MAX) return { ok: false, reason: 'cap' }
      names = [...names, n]
      persist()
      return { ok: true }
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
