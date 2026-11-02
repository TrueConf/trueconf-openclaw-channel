import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { canEditNicknames, createNicknameTools } from '../../src/nickname-tools'

const store = (over: Record<string, unknown> = {}) => ({
  add: vi.fn(() => ({ status: 'added' })),
  remove: vi.fn(() => ({ status: 'removed' })),
  list: vi.fn(() => ['клешня']),
  matches: vi.fn(() => false),
  ...over,
})

const find = (s: ReturnType<typeof store>, name: string, canEdit = true) =>
  createNicknameTools(s as never, canEdit).find((t) => t.name === name)!

describe('nickname tools', () => {
  it('exposes three tools with label+parameters', () => {
    const tools = createNicknameTools(store() as never, true)
    expect(tools.map((t) => t.name)).toEqual(['remember_bot_nickname', 'forget_bot_nickname', 'list_bot_nicknames'])
    for (const t of tools) {
      expect(typeof t.label).toBe('string')
      expect(t.parameters).toBeDefined()
    }
  })

  it('remember writes raw input but confirms with the normalized name', async () => {
    const s = store()
    const res = await find(s, 'remember_bot_nickname').execute('id', { name: '  Клешня  ' })
    expect(s.add).toHaveBeenCalledWith('  Клешня  ')
    expect(res.content[0].text).toBe('Запомнил псевдоним «клешня».')
    expect('details' in res).toBe(true)
  })

  it('remember surfaces too_short / cap / persist_failed / exists', async () => {
    const text = async (status: string) =>
      (await find(store({ add: () => ({ status }) }), 'remember_bot_nickname').execute('id', { name: 'клешня' })).content[0].text
    expect(await text('too_short')).toContain('короткий')
    expect(await text('reserved')).toContain('общее слово')
    expect(await text('cap')).toContain('лимит')
    expect(await text('persist_failed')).toContain('пропадёт после перезапуска')
    expect(await text('exists')).toContain('уже задан')
    expect(await text('busy')).toContain('попробуй ещё раз')
  })

  it('refuses to change nicknames for a requester without rights, but still lists them', async () => {
    const s = store()
    const refusal =
      'Менять псевдонимы могут только пользователи из channels.trueconf.allowFrom: псевдонимы действуют во всех группах бота.'
    expect((await find(s, 'remember_bot_nickname', false).execute('id', { name: 'клешня' })).content[0].text).toBe(refusal)
    expect((await find(s, 'forget_bot_nickname', false).execute('id', { name: 'клешня' })).content[0].text).toBe(refusal)
    expect(s.add).not.toHaveBeenCalled()
    expect(s.remove).not.toHaveBeenCalled()
    expect((await find(s, 'list_bot_nicknames', false).execute('id', {})).content[0].text).toBe('Псевдонимы: клешня.')
  })

  it('forget reports removed / not-found / persist_failed', async () => {
    const text = async (status: string) =>
      (await find(store({ remove: () => ({ status }) }), 'forget_bot_nickname').execute('id', { name: 'клешня' })).content[0].text
    expect(await text('removed')).toContain('Убрал')
    expect(await text('not_found')).toContain('не найден')
    expect(await text('persist_failed')).toContain('вернётся после перезапуска')
    expect(await text('busy')).toContain('попробуй ещё раз')
  })

  it('list returns current names, or a placeholder when empty', async () => {
    expect((await find(store(), 'list_bot_nicknames').execute('id', {})).content[0].text).toContain('клешня')
    expect((await find(store({ list: () => [] }), 'list_bot_nicknames').execute('id', {})).content[0].text).toContain('пока нет')
  })

  // The openclaw runtime rejects api.registerTool unless the plugin manifest
  // declares the tool name under contracts.tools. Keep the manifest in sync with
  // the tools this factory registers (the mocked api in other tests can't catch
  // this — only the real gateway loader enforces it).
  it('manifest declares contracts.tools for every registered nickname tool', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf8'),
    ) as { contracts?: { tools?: string[] } }
    const declared = manifest.contracts?.tools ?? []
    for (const t of createNicknameTools(store() as never)) expect(declared).toContain(t.name)
  })
})

describe('canEditNicknames', () => {
  const cfg = (allowFrom?: string[]) => ({ channels: { trueconf: { serverUrl: 's', username: 'u', password: 'p', allowFrom } } })

  it('allows a TrueConf sender listed in allowFrom', () => {
    expect(canEditNicknames({ messageChannel: 'trueconf', requesterSenderId: 'alice@srv', config: cfg(['alice@srv']) })).toBe(true)
  })

  it('refuses a TrueConf sender missing from allowFrom, or any sender when allowFrom is empty', () => {
    expect(canEditNicknames({ messageChannel: 'trueconf', requesterSenderId: 'bob@srv', config: cfg(['alice@srv']) })).toBe(false)
    expect(canEditNicknames({ messageChannel: 'trueconf', requesterSenderId: 'bob@srv', config: cfg() })).toBe(false)
  })

  it('allows everyone when allowFrom lists "*"', () => {
    expect(canEditNicknames({ messageChannel: 'trueconf', requesterSenderId: 'bob@srv', config: cfg(['*']) })).toBe(true)
  })

  it('prefers the runtime config snapshot over the static one', () => {
    expect(
      canEditNicknames({
        messageChannel: 'trueconf',
        requesterSenderId: 'bob@srv',
        config: cfg(['alice@srv']),
        getRuntimeConfig: () => cfg(['bob@srv']),
      }),
    ).toBe(true)
  })

  it('refuses a run without a trusted TrueConf sender', () => {
    expect(canEditNicknames({ messageChannel: 'telegram', requesterSenderId: 'alice@srv', config: cfg(['alice@srv']) })).toBe(false)
    expect(canEditNicknames({ messageChannel: 'trueconf', config: cfg(['*']) })).toBe(false)
    expect(canEditNicknames({})).toBe(false)
  })

  it('allows the owner on any channel', () => {
    expect(canEditNicknames({ senderIsOwner: true, messageChannel: 'webchat' })).toBe(true)
  })
})
