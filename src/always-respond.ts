import type { ParsedAlwaysRespondConfig } from './config'

export interface WireAdapter {
  botUserId: string | null
  getChats: (payload: { count: number; page: number }) => Promise<Array<{ chatId: string; title: string; chatType: number }>>
  getChatByID: (chatId: string) => Promise<{ chatType: number; title: string } | null>
  logger: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void }
}

interface ResolverEvent {
  kind: 'add' | 'remove' | 'removeChat' | 'rename' | 'createGroup' | 'createChannel'
  chatId: string
  title?: string
  userId?: string
}

export class AlwaysRespondResolver {
  private static readonly GET_CHATS_PAGE_SIZE = 100
  private static readonly GET_CHATS_BACKOFF_MS = [500, 1000, 2000] as const
  private static readonly GROUP_CHAT_TYPE = 2

  private readonly configuredChatIds: Set<string>
  private readonly configuredTitles: Set<string>
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
        if (chat.chatType !== AlwaysRespondResolver.GROUP_CHAT_TYPE) continue
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

  private async handleEvent(_ev: ResolverEvent): Promise<void> {
    // Filled in Part 4.
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
