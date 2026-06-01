import { describe, it, expect, vi } from 'vitest'
import { createNicknameTools } from '../../src/nickname-tools'

const store = () => ({
  add: vi.fn(() => ({ ok: true })),
  remove: vi.fn(() => true),
  list: vi.fn(() => ['клешня']),
  matches: vi.fn(() => false),
})

describe('nickname tools', () => {
  it('exposes three tools with label+parameters', () => {
    const tools = createNicknameTools(store() as never)
    expect(tools.map((t) => t.name)).toEqual(['remember_bot_nickname', 'forget_bot_nickname', 'list_bot_nicknames'])
    for (const t of tools) {
      expect(typeof t.label).toBe('string')
      expect(t.parameters).toBeDefined()
    }
  })

  it('remember writes to store and returns content+details', async () => {
    const s = store()
    const t = createNicknameTools(s as never).find((x) => x.name === 'remember_bot_nickname')!
    const res = await t.execute('id', { name: 'Клешня' })
    expect(s.add).toHaveBeenCalledWith('Клешня')
    expect(res.content[0].text).toContain('Запомнил')
    expect('details' in res).toBe(true)
  })

  it('list returns current names', async () => {
    const t = createNicknameTools(store() as never).find((x) => x.name === 'list_bot_nicknames')!
    expect((await t.execute('id', {})).content[0].text).toContain('клешня')
  })
})
