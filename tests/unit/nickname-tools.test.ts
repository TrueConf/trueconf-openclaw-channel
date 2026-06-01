import { describe, it, expect, vi } from 'vitest'
import { createNicknameTools } from '../../src/nickname-tools'

const store = (over: Record<string, unknown> = {}) => ({
  add: vi.fn(() => ({ status: 'added' })),
  remove: vi.fn(() => true),
  list: vi.fn(() => ['клешня']),
  matches: vi.fn(() => false),
  ...over,
})

const find = (s: ReturnType<typeof store>, name: string) =>
  createNicknameTools(s as never).find((t) => t.name === name)!

describe('nickname tools', () => {
  it('exposes three tools with label+parameters', () => {
    const tools = createNicknameTools(store() as never)
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
  })

  it('forget reports removed vs not-found', async () => {
    expect((await find(store({ remove: () => true }), 'forget_bot_nickname').execute('id', { name: 'клешня' })).content[0].text).toContain('Убрал')
    expect((await find(store({ remove: () => false }), 'forget_bot_nickname').execute('id', { name: 'нет' })).content[0].text).toContain('не найден')
  })

  it('list returns current names, or a placeholder when empty', async () => {
    expect((await find(store(), 'list_bot_nicknames').execute('id', {})).content[0].text).toContain('клешня')
    expect((await find(store({ list: () => [] }), 'list_bot_nicknames').execute('id', {})).content[0].text).toContain('пока нет')
  })
})
