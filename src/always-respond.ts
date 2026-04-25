import type { ParsedAlwaysRespondConfig } from './config'

export class AlwaysRespondResolver {
  private readonly configuredChatIds: Set<string>
  private readonly configuredTitles: Set<string>
  private readonly titleByChatId = new Map<string, string>()
  private readonly titleResolvedChatIds = new Set<string>()

  constructor(parsed: ParsedAlwaysRespondConfig) {
    this.configuredChatIds = parsed.configuredChatIds
    this.configuredTitles = parsed.configuredTitles
  }

  isAlwaysRespond = (chatId: string): boolean => {
    return this.configuredChatIds.has(chatId) || this.titleResolvedChatIds.has(chatId)
  }
}
