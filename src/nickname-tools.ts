import { Type } from '@sinclair/typebox'
import { isCommandSenderAllowed } from './config'
import type { NicknameStore } from './nickname-store'
import { normalizeNickname } from './nickname-match'
import type { TrueConfChannelConfig } from './types'

// Minimal local mirror of the SDK's AgentToolResult<unknown> — a structural
// subtype of `{ content: (TextContent | ImageContent)[]; details: T }` (verified
// against @mariozechner/pi-agent-core). Kept hand-rolled so these plain tool
// objects register via api.registerTool without importing SDK internals;
// re-verify this shape on an SDK/pluginApi bump, as there is no compile-time
// tie-back to the upstream type.
type AgentToolResult = { content: Array<{ type: 'text'; text: string }>; details: unknown }

const say = (text: string): AgentToolResult => ({ content: [{ type: 'text', text }], details: undefined })

export const NICKNAME_TOOL_NAMES = ['remember_bot_nickname', 'forget_bot_nickname', 'list_bot_nicknames']

// The fields of OpenClaw's tool-factory context this module reads. The sender
// and owner bit come from the inbound turn (runtime-provided, not tool args).
export type NicknameToolContext = {
  config?: unknown
  getRuntimeConfig?: () => unknown
  messageChannel?: string
  requesterSenderId?: string
  senderIsOwner?: boolean
}

// Same rule as control commands: the owner, or a TrueConf sender listed in
// channels.trueconf.allowFrom ("*" lists everyone).
export function canEditNicknames(ctx: NicknameToolContext): boolean {
  if (ctx.senderIsOwner === true) return true
  if (ctx.messageChannel !== 'trueconf' || !ctx.requesterSenderId) return false
  const cfg = (ctx.getRuntimeConfig?.() ?? ctx.config) as { channels?: { trueconf?: TrueConfChannelConfig } } | undefined
  const channelConfig = cfg?.channels?.trueconf
  return channelConfig !== undefined && isCommandSenderAllowed(channelConfig, ctx.requesterSenderId)
}

const NOT_ALLOWED =
  'Менять псевдонимы могут только пользователи из channels.trueconf.allowFrom: псевдонимы действуют во всех группах бота.'
const BUSY = 'Список псевдонимов сейчас меняет другой процесс, попробуй ещё раз.'

// Three nickname-management tools the agent calls in response to natural
// language ("запомни, тебя зовут Клешня"). The nickname list is global: a name
// makes the bot answer in every group of every account. So only a requester the
// channel trusts with control commands (`canEdit`, computed by the caller from
// the run's trusted sender) may change it; anyone may list it. User-facing
// messages echo the normalized (stored) form, not the raw input, so they
// reflect what is matched.
export function createNicknameTools(store: NicknameStore, canEdit: boolean) {
  return [
    {
      name: 'remember_bot_nickname',
      label: 'Запомнить псевдоним',
      description:
        'Запомнить псевдоним, на который бот будет откликаться во всех группах. Доступно только пользователям из allowFrom.',
      parameters: Type.Object({ name: Type.String({ description: 'Псевдоним' }) }),
      async execute(_id: string, p: Record<string, unknown>): Promise<AgentToolResult> {
        if (!canEdit) return say(NOT_ALLOWED)
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
          case 'busy':
            return say(BUSY)
        }
      },
    },
    {
      name: 'forget_bot_nickname',
      label: 'Убрать псевдоним',
      description: 'Убрать ранее заданный псевдоним бота. Доступно только пользователям из allowFrom.',
      parameters: Type.Object({ name: Type.String({ description: 'Псевдоним' }) }),
      async execute(_id: string, p: Record<string, unknown>): Promise<AgentToolResult> {
        if (!canEdit) return say(NOT_ALLOWED)
        const norm = normalizeNickname(String(p.name ?? ''))
        const r = store.remove(String(p.name ?? ''))
        switch (r.status) {
          case 'removed':
            return say(`Убрал псевдоним «${norm}».`)
          case 'not_found':
            return say(`Псевдоним «${norm}» не найден.`)
          case 'persist_failed':
            return say(`Убрал псевдоним «${norm}», но не смог сохранить — он вернётся после перезапуска.`)
          case 'busy':
            return say(BUSY)
        }
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
