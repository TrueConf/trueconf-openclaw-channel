import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { saveJsonFile } from 'openclaw/plugin-sdk/json-store'
import type { Logger } from './types'
import { matchesAnyNickname, normalizeNickname } from './nickname-match'

const MIN_LEN = 3
const MAX = 50
const LOCK_STALE_MS = 10_000
const LOCK_ATTEMPTS = 100
const LOCK_RETRY_MS = 20

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
  | { status: 'busy' }

// Closed outcome of remove(): mirrors add() so the tool layer can tell the user
// the truth — including 'persist_failed', when the name was dropped from the
// in-memory list but the disk write threw, so it will reappear on restart.
export type NicknameRemoveResult =
  | { status: 'removed' }
  | { status: 'not_found' }
  | { status: 'persist_failed' }
  | { status: 'busy' }

export interface NicknameStore {
  list(): string[]
  matches(text: string): boolean
  add(name: string): NicknameAddResult
  remove(name: string): NicknameRemoveResult
}

// Global, flat, disk-backed list of bot nicknames. The list is global (one set
// per bot) — no chatId — because activation runs in the channel layer before
// the agent, and the nickname tools' context carries the sender but not the
// originating chat (see spec "Почему не пер-чат"). Reads parse the file
// directly so a corrupt file is observable (the SDK json-store hides
// missing-vs-corrupt behind a single undefined); writes go through the SDK
// saveJsonFile (it creates the dir and sets perms). Both load and persist log
// failures via the optional logger — a silent reset or a swallowed write, with
// the tool still reporting success, is the worst failure mode for this feature.
export function createNicknameStore(filePath: string, logger: Logger | null = null): NicknameStore {
  let names: string[] = loadNicknames(filePath, logger)
  let lastMtimeMs = mtimeMsOrZero(filePath)

  // The list is global but the plugin is instantiated in more than one runtime
  // context (the inbound gate and the agent tools each hold their own store),
  // and disk is the only shared state. Reload when the file's mtime moved so a
  // nickname registered through a tool is seen live by the gate — not only after
  // a restart. Called before every read; mutate() always re-reads under its lock.
  const refreshIfChanged = (): void => {
    const m = mtimeMsOrZero(filePath)
    if (m !== lastMtimeMs) {
      names = loadNicknames(filePath, logger)
      lastMtimeMs = m
    }
  }

  const persist = (): boolean => {
    try {
      saveJsonFile(filePath, { nicknames: names } satisfies Data)
      lastMtimeMs = mtimeMsOrZero(filePath)
      return true
    } catch (err) {
      logger?.error(
        `[trueconf] nickname store: failed to persist ${filePath}: ${err instanceof Error ? err.message : String(err)} — in-memory list will be lost on restart`,
      )
      return false
    }
  }

  // Read-modify-write under a lock, so two processes adding names at once do
  // not drop each other's write. The list is re-read inside the lock because
  // an mtime check can miss a write made within the same timestamp tick.
  // `change` returns an outcome when it leaves the list untouched, or null
  // after a change that should be persisted and reported as `done`.
  const mutate = <R extends { status: string }>(change: () => R | null, done: R): R | { status: 'busy' | 'persist_failed' } => {
    const lock = acquireLock(filePath, logger)
    if (!lock) return { status: 'busy' }
    try {
      names = loadNicknames(filePath, logger)
      lastMtimeMs = mtimeMsOrZero(filePath)
      const outcome = change()
      if (outcome) return outcome
      return persist() ? done : { status: 'persist_failed' }
    } finally {
      lock.release()
    }
  }

  return {
    list: () => {
      refreshIfChanged()
      return [...names]
    },
    matches: (text) => {
      refreshIfChanged()
      return matchesAnyNickname(text, names)
    },
    add: (name) => {
      const n = normalizeNickname(name)
      if (n.length < MIN_LEN) return { status: 'too_short' }
      if (RESERVED.has(n)) return { status: 'reserved' }
      return mutate((): NicknameAddResult | null => {
        if (names.includes(n)) return { status: 'exists' }
        if (names.length >= MAX) return { status: 'cap' }
        names = [...names, n]
        return null
      }, { status: 'added' })
    },
    remove: (name) => {
      const n = normalizeNickname(name)
      return mutate((): NicknameRemoveResult | null => {
        const i = names.indexOf(n)
        if (i < 0) return { status: 'not_found' }
        names = names.filter((_, j) => j !== i)
        return null
      }, { status: 'removed' })
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

// Cross-process lock: a sidecar file created with O_EXCL. A lock older than
// LOCK_STALE_MS belongs to a process that died mid-write and is taken over.
// Returns null when the lock stays busy for LOCK_ATTEMPTS * LOCK_RETRY_MS.
function acquireLock(filePath: string, logger: Logger | null): { release: () => void } | null {
  const lockPath = `${filePath}.lock`
  // When the lock file cannot be created, persist() cannot write either and
  // reports the failure, so the change goes ahead without a lock.
  const unlocked = (err: unknown) => {
    logger?.warn(`[trueconf] nickname store: cannot create ${lockPath}: ${err instanceof Error ? err.message : String(err)}`)
    return { release: () => {} }
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch (err) {
    return unlocked(err)
  }
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      closeSync(openSync(lockPath, 'wx'))
      return { release: () => rmSync(lockPath, { force: true }) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return unlocked(err)
      const lockedAt = mtimeMsOrZero(lockPath)
      if (lockedAt === 0) continue
      if (Date.now() - lockedAt > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true })
        continue
      }
      Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS)
    }
  }
  logger?.warn(`[trueconf] nickname store: ${lockPath} stayed locked; change not applied`)
  return null
}

// Modification time in ms, or 0 when the file is absent/unstattable — a cheap
// change sentinel so the store can detect out-of-process writes without reading
// the whole file on every call.
function mtimeMsOrZero(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}
