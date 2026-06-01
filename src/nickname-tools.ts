import { Type } from '@sinclair/typebox'
import type { NicknameStore } from './nickname-store'

// Minimal shape of the agent tool result. Structurally matches the SDK's
// AgentToolResult<unknown> (content of text blocks + details), so these plain
// tool objects register via api.registerTool without importing SDK internals.
type AgentToolResult = { content: Array<{ type: 'text'; text: string }>; details: unknown }

const say = (text: string): AgentToolResult => ({ content: [{ type: 'text', text }], details: undefined })

// Three global nickname-management tools the agent calls in response to natural
// language ("запомни, тебя зовут Клешня"). Global store → no chatId, so these
// are plain tool objects (not per-chat factories).
export function createNicknameTools(store: NicknameStore) {
  return [
    {
      name: 'remember_bot_nickname',
      label: 'Запомнить погоняло',
      description: 'Запомнить псевдоним (погоняло), на который бот будет откликаться в группах.',
      parameters: Type.Object({ name: Type.String({ description: 'Псевдоним' }) }),
      async execute(_id: string, p: Record<string, unknown>): Promise<AgentToolResult> {
        const name = String(p.name ?? '')
        const r = store.add(name)
        if (r.ok) return say(`Запомнил погоняло «${name}».`)
        if (r.reason === 'too_short') return say('Слишком короткое погоняло (мин. 2 символа).')
        return say('Достигнут лимит погонял.')
      },
    },
    {
      name: 'forget_bot_nickname',
      label: 'Убрать погоняло',
      description: 'Убрать ранее заданный псевдоним бота.',
      parameters: Type.Object({ name: Type.String({ description: 'Псевдоним' }) }),
      async execute(_id: string, p: Record<string, unknown>): Promise<AgentToolResult> {
        const name = String(p.name ?? '')
        return say(store.remove(name) ? `Убрал погоняло «${name}».` : `Погоняло «${name}» не найдено.`)
      },
    },
    {
      name: 'list_bot_nicknames',
      label: 'Список погонял',
      description: 'Показать заданные псевдонимы бота.',
      parameters: Type.Object({}),
      async execute(): Promise<AgentToolResult> {
        const names = store.list()
        return say(names.length ? `Погоняла: ${names.join(', ')}.` : 'Погонял пока нет.')
      },
    },
  ]
}
