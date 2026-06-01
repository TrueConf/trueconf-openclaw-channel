import { Type } from '@sinclair/typebox'
import type { NicknameStore } from './nickname-store'
import { normalizeNickname } from './nickname-match'

// Minimal local mirror of the SDK's AgentToolResult<unknown> — a structural
// subtype of `{ content: (TextContent | ImageContent)[]; details: T }` (verified
// against @mariozechner/pi-agent-core). Kept hand-rolled so these plain tool
// objects register via api.registerTool without importing SDK internals;
// re-verify this shape on an SDK/pluginApi bump, as there is no compile-time
// tie-back to the upstream type.
type AgentToolResult = { content: Array<{ type: 'text'; text: string }>; details: unknown }

const say = (text: string): AgentToolResult => ({ content: [{ type: 'text', text }], details: undefined })

// Three global nickname-management tools the agent calls in response to natural
// language ("запомни, тебя зовут Клешня"). Global store → no chatId, so these
// are plain tool objects (not per-chat factories). User-facing messages echo the
// normalized (stored) form, not the raw input, so they reflect what is matched.
export function createNicknameTools(store: NicknameStore) {
  return [
    {
      name: 'remember_bot_nickname',
      label: 'Запомнить псевдоним',
      description: 'Запомнить псевдоним, на который бот будет откликаться в группах.',
      parameters: Type.Object({ name: Type.String({ description: 'Псевдоним' }) }),
      async execute(_id: string, p: Record<string, unknown>): Promise<AgentToolResult> {
        const norm = normalizeNickname(String(p.name ?? ''))
        const r = store.add(String(p.name ?? ''))
        switch (r.status) {
          case 'added':
            return say(`Запомнил псевдоним «${norm}».`)
          case 'exists':
            return say(`Псевдоним «${norm}» уже задан.`)
          case 'too_short':
            return say('Слишком короткий псевдоним (мин. 3 символа).')
          case 'reserved':
            return say(`«${norm}» — слишком общее слово для псевдонима, выбери что-нибудь поотличительнее.`)
          case 'cap':
            return say('Достигнут лимит псевдонимов.')
          case 'persist_failed':
            return say(`Запомнил псевдоним «${norm}», но не смог сохранить — он пропадёт после перезапуска.`)
        }
      },
    },
    {
      name: 'forget_bot_nickname',
      label: 'Убрать псевдоним',
      description: 'Убрать ранее заданный псевдоним бота.',
      parameters: Type.Object({ name: Type.String({ description: 'Псевдоним' }) }),
      async execute(_id: string, p: Record<string, unknown>): Promise<AgentToolResult> {
        const norm = normalizeNickname(String(p.name ?? ''))
        return say(store.remove(String(p.name ?? '')) ? `Убрал псевдоним «${norm}».` : `Псевдоним «${norm}» не найден.`)
      },
    },
    {
      name: 'list_bot_nicknames',
      label: 'Список псевдонимов',
      description: 'Показать заданные псевдонимы бота.',
      parameters: Type.Object({}),
      async execute(): Promise<AgentToolResult> {
        const names = store.list()
        return say(names.length ? `Псевдонимы: ${names.join(', ')}.` : 'Псевдонимов пока нет.')
      },
    },
  ]
}
