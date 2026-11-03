import type { OpenClawConfig } from 'openclaw/plugin-sdk/core'
import {
  createChannelHistoryWindow,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from 'openclaw/plugin-sdk/reply-history'
import type { TrueConfChannelOptions } from './types'

// The lines one addressed turn takes from a group's history. commit() drops
// them once the turn is dispatched; release() leaves them for the next turn.
export interface HistoryReservation {
  entries: readonly HistoryEntry[]
  commit: () => void
  release: () => void
}

export const NOTHING_RESERVED: HistoryReservation = { entries: [], commit: () => {}, release: () => {} }

// channels.trueconf.historyLimit, then messages.groupChat.historyLimit, then
// OpenClaw's default of 50. 0 turns history off.
export function resolveHistoryLimit(cfg: OpenClawConfig | null): number {
  const own = (cfg?.channels?.trueconf as TrueConfChannelOptions | undefined)?.historyLimit
  return own ?? cfg?.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT
}

// Unaddressed group lines, in memory only, per account and chat. OpenClaw's
// history window keeps the last `limit` lines per chat and the 1000 most
// recently used chats; nothing reaches a session until a turn takes them.
// A restart loses them.
export class GroupHistory {
  private readonly lines = new Map<string, HistoryEntry[]>()
  private readonly window = createChannelHistoryWindow({ historyMap: this.lines })
  // Lines a dispatched turn holds, so a concurrent turn in the same chat
  // does not take them too.
  private readonly reserved = new WeakSet<HistoryEntry>()

  // Returns false when history is off (limit 0).
  record(accountId: string, chatId: string, entry: HistoryEntry, limit: number): boolean {
    return this.window.record({ historyKey: key(accountId, chatId), entry, limit }).length > 0
  }

  // Takes the free lines sent up to `until` (the addressed message's
  // timestamp). Lines that arrive later, or while the turn runs, stay for the
  // next turn.
  reserve(accountId: string, chatId: string, until: number): HistoryReservation {
    const historyKey = key(accountId, chatId)
    const taken = (this.lines.get(historyKey) ?? []).filter(
      (entry) => !this.reserved.has(entry) && (entry.timestamp ?? 0) <= until,
    )
    if (taken.length === 0) return NOTHING_RESERVED
    for (const entry of taken) this.reserved.add(entry)
    let settled = false
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      for (const entry of taken) this.reserved.delete(entry)
      return true
    }
    return {
      entries: taken,
      commit: () => {
        if (!settle()) return
        const done = new Set(taken)
        const kept = (this.lines.get(historyKey) ?? []).filter((entry) => !done.has(entry))
        if (kept.length > 0) this.lines.set(historyKey, kept)
        else this.lines.delete(historyKey)
      },
      release: () => {
        settle()
      },
    }
  }

  forget(accountId: string, chatId: string): void {
    this.lines.delete(key(accountId, chatId))
  }

  clear(): void {
    this.lines.clear()
  }
}

function key(accountId: string, chatId: string): string {
  return `${accountId}\u0000${chatId}`
}
