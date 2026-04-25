import type { ParsedAlwaysRespondConfig } from './config'
import { TrueConfChatType } from './types'

export interface WireAdapter {
  botUserId: string | null
  getChats: (payload: { count: number; page: number }) => Promise<Array<{ chatId: string; title: string; chatType: number }>>
  getChatByID: (chatId: string) => Promise<{ chatType: number; title: string } | null>
  logger: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void }
}

export type ResolverEvent =
  | { kind: 'add'; chatId: string; userId: string }
  | { kind: 'remove'; chatId: string; userId: string }
  | { kind: 'removeChat'; chatId: string }
  | { kind: 'rename'; chatId: string; title: string }
  | { kind: 'createGroup'; chatId: string }

export class AlwaysRespondResolver {
  private static readonly GET_CHATS_PAGE_SIZE = 100
  private static readonly GET_CHATS_BACKOFF_MS = [500, 1000, 2000] as const

  private readonly configuredChatIds: ReadonlySet<string>
  private readonly configuredTitles: ReadonlySet<string>
  private readonly titleByChatId = new Map<string, string>()
  private readonly titleResolvedChatIds = new Set<string>()

  private queue: ResolverEvent[] = []
  private draining = false
  private buffering = false

  constructor(parsed: ParsedAlwaysRespondConfig, private readonly wire: WireAdapter) {
    this.configuredChatIds = parsed.configuredChatIds
    this.configuredTitles = parsed.configuredTitles
  }

  isAlwaysRespond = (chatId: string): boolean => {
    return this.configuredChatIds.has(chatId) || this.titleResolvedChatIds.has(chatId)
  }

  enqueueEvent(ev: ResolverEvent): void {
    this.queue.push(ev)
    if (!this.buffering) void this.drainQueue()
  }

  async rebuildFromWire(): Promise<void> {
    this.wire.logger.info('[trueconf] always-respond: rebuilding from wire')
    this.buffering = true
    try {
      this.titleByChatId.clear()
      this.titleResolvedChatIds.clear()

      const snapshot = await this.fetchAllChats()
      for (const chat of snapshot) {
        if (chat.chatType !== TrueConfChatType.GROUP) continue
        const normTitle = chat.title.trim().toLowerCase()
        this.titleByChatId.set(chat.chatId, normTitle)
        if (this.configuredTitles.has(normTitle)) {
          this.titleResolvedChatIds.add(chat.chatId)
        }
      }

      this.emitStartupWarnings()
    } finally {
      this.buffering = false
    }
    void this.drainQueue()
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const ev = this.queue.shift()!
        await this.handleEvent(ev)
      }
    } finally {
      this.draining = false
    }
  }

  private async fetchChatByIDWithRetry(chatId: string): Promise<{ chatType: number; title: string } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.wire.getChatByID(chatId)
        if (result) return result
        return null
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 200))
      }
    }
    return null
  }

  private async handleEvent(ev: ResolverEvent): Promise<void> {
    switch (ev.kind) {
      case 'add':
      case 'createGroup': {
        // 'createGroupChat' is only delivered to the creator (the bot here),
        // so there is no userId payload to guard on for that kind.
        if (ev.kind === 'add' && ev.userId !== this.wire.botUserId) return
        const info = await this.fetchChatByIDWithRetry(ev.chatId)
        if (!info) {
          this.wire.logger.warn(
            `[trueconf] always-respond: getChatByID(${ev.chatId}) failed for ${ev.kind}; skipping bypass update — will reconcile at next enumerate`,
          )
          return
        }
        if (info.chatType !== TrueConfChatType.GROUP) return
        const normTitle = info.title.trim().toLowerCase()
        this.titleByChatId.set(ev.chatId, normTitle)
        if (this.configuredTitles.has(normTitle)) {
          this.titleResolvedChatIds.add(ev.chatId)
          this.wire.logger.info(
            `[trueconf] chat ${ev.chatId} joined group "${normTitle}" — added to always-respond`,
          )
          this.warnIfDuplicate(normTitle, ev.chatId)
        } else {
          this.wire.logger.info(`[trueconf] chat ${ev.chatId} joined group "${normTitle}"`)
        }
        return
      }
      case 'rename': {
        const oldNorm = this.titleByChatId.get(ev.chatId)
        if (oldNorm === undefined) {
          const info = await this.fetchChatByIDWithRetry(ev.chatId)
          if (!info) {
            this.wire.logger.warn(
              `[trueconf] always-respond: getChatByID(${ev.chatId}) failed for rename; skipping bypass update — will reconcile at next enumerate`,
            )
            return
          }
          if (info.chatType !== TrueConfChatType.GROUP) return
          const newNorm = info.title.trim().toLowerCase()
          this.titleByChatId.set(ev.chatId, newNorm)
          if (this.configuredTitles.has(newNorm)) {
            this.titleResolvedChatIds.add(ev.chatId)
            this.wire.logger.info(
              `[trueconf] chat ${ev.chatId} joined group "${newNorm}" — added to always-respond`,
            )
            this.warnIfDuplicate(newNorm, ev.chatId)
          }
          return
        }
        const newNorm = ev.title.trim().toLowerCase()
        this.titleByChatId.set(ev.chatId, newNorm)
        const wasMatch = this.configuredTitles.has(oldNorm)
        const isMatch = this.configuredTitles.has(newNorm)
        if (wasMatch && !isMatch) {
          this.titleResolvedChatIds.delete(ev.chatId)
          if (this.configuredChatIds.has(ev.chatId)) {
            this.wire.logger.info(
              `[trueconf] chat ${ev.chatId} renamed "${oldNorm}" → "${newNorm}", removed from title-resolved (still active via configured chatId)`,
            )
          } else {
            this.wire.logger.info(
              `[trueconf] chat ${ev.chatId} renamed "${oldNorm}" → "${newNorm}", removed from always-respond`,
            )
          }
        } else if (!wasMatch && isMatch) {
          this.titleResolvedChatIds.add(ev.chatId)
          this.wire.logger.info(
            `[trueconf] chat ${ev.chatId} renamed "${oldNorm}" → "${newNorm}", added to always-respond`,
          )
          this.warnIfDuplicate(newNorm, ev.chatId)
        } else {
          this.wire.logger.info(`[trueconf] chat ${ev.chatId} renamed "${oldNorm}" → "${newNorm}"`)
        }
        return
      }
      case 'remove':
      case 'removeChat': {
        if (ev.kind === 'remove' && ev.userId !== this.wire.botUserId) return
        this.titleByChatId.delete(ev.chatId)
        const wasTitleResolved = this.titleResolvedChatIds.delete(ev.chatId)
        if (wasTitleResolved) {
          if (this.configuredChatIds.has(ev.chatId)) {
            this.wire.logger.info(
              `[trueconf] chat ${ev.chatId} removed — dropped from title-resolved (still active via configured chatId)`,
            )
          } else {
            this.wire.logger.info(`[trueconf] chat ${ev.chatId} removed — dropped from always-respond`)
          }
        }
        return
      }
      default: {
        // Adding a new ResolverEvent kind without a handler will fail to compile here.
        const _exhaustive: never = ev
        void _exhaustive
        return
      }
    }
  }

  private warnIfDuplicate(title: string, newChatId: string): void {
    const others: string[] = []
    for (const chatId of this.titleResolvedChatIds) {
      if (this.titleByChatId.get(chatId) === title && chatId !== newChatId) others.push(chatId)
    }
    if (others.length > 0) {
      this.wire.logger.warn(
        `[trueconf] always-respond: title "${title}" now matches ${others.length + 1} chats: ${[newChatId, ...others].join(', ')}`,
      )
    }
  }

  private async fetchAllChats(): Promise<Array<{ chatId: string; title: string; chatType: number }>> {
    const all: Array<{ chatId: string; title: string; chatType: number }> = []
    let page = 1
    while (true) {
      const chunk = await this.fetchChatsPageWithRetry(page)
      if (chunk === null) {
        this.wire.logger.warn(
          '[trueconf] always-respond: getChats failed after 3 attempts; title entries inactive until next enumerate; configured chatIds remain active',
        )
        return []
      }
      this.wire.logger.info(`[trueconf] always-respond: getChats page ${page} returned ${chunk.length} chats`)
      all.push(...chunk)
      if (chunk.length < AlwaysRespondResolver.GET_CHATS_PAGE_SIZE) break
      page += 1
    }
    return all
  }

  private async fetchChatsPageWithRetry(page: number): Promise<Array<{ chatId: string; title: string; chatType: number }> | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.wire.getChats({ count: AlwaysRespondResolver.GET_CHATS_PAGE_SIZE, page })
      } catch {
        if (attempt < 2) await new Promise((r) => setTimeout(r, AlwaysRespondResolver.GET_CHATS_BACKOFF_MS[attempt]))
      }
    }
    return null
  }

  private emitStartupWarnings(): void {
    const titleMatches = new Map<string, string[]>()
    for (const [chatId, title] of this.titleByChatId) {
      if (!this.configuredTitles.has(title)) continue
      const arr = titleMatches.get(title) ?? []
      arr.push(chatId)
      titleMatches.set(title, arr)
    }

    for (const title of this.configuredTitles) {
      const matches = titleMatches.get(title) ?? []
      if (matches.length === 0) {
        this.wire.logger.info(
          `[trueconf] always-respond: title "${title}" not found now (will resolve when bot joins a matching group)`,
        )
      } else if (matches.length > 1) {
        this.wire.logger.warn(
          `[trueconf] always-respond: title "${title}" matches ${matches.length} chats, applying to all: ${matches.join(', ')}`,
        )
      }
    }

    for (const chatId of this.configuredChatIds) {
      if (!this.titleByChatId.has(chatId)) {
        this.wire.logger.info(
          `[trueconf] always-respond: configured chatId ${chatId} not a group bot is in; bypass stays armed`,
        )
      }
    }

    this.wire.logger.info(
      `[trueconf] always-respond: ready — ${this.configuredChatIds.size} direct chatIds, ${this.titleResolvedChatIds.size} title-resolved chatIds (${this.configuredTitles.size - titleMatches.size} titles pending)`,
    )
  }
}
