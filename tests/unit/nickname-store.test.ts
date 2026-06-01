import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNicknameStore } from '../../src/nickname-store'

let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'nick-')), 'n.json')
})

describe('global nickname store', () => {
  it('add/list normalized + deduped', () => {
    const s = createNicknameStore(file)
    expect(s.add('Клешня').ok).toBe(true)
    s.add('клешня ')
    expect(s.list()).toEqual(['клешня'])
  })

  it('rejects too-short', () => {
    const s = createNicknameStore(file)
    expect(s.add('я').ok).toBe(false)
    expect(s.list()).toEqual([])
  })

  it('cap (50)', () => {
    const s = createNicknameStore(file)
    for (let i = 0; i < 60; i++) s.add(`имя${i}`)
    expect(s.list().length).toBe(50)
  })

  it('remove', () => {
    const s = createNicknameStore(file)
    s.add('Клешня')
    expect(s.remove('КЛЕШНЯ')).toBe(true)
    expect(s.list()).toEqual([])
  })

  it('matches whole-word', () => {
    const s = createNicknameStore(file)
    s.add('Клешня')
    expect(s.matches('эй клешня!')).toBe(true)
    expect(s.matches('клешнятина')).toBe(false)
  })

  it('persists across reopen', () => {
    createNicknameStore(file).add('Клешня')
    expect(createNicknameStore(file).list()).toEqual(['клешня'])
  })
})
