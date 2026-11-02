import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const saveFails = vi.hoisted(() => ({ on: false }))
vi.mock('openclaw/plugin-sdk/json-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('openclaw/plugin-sdk/json-store')>()
  return {
    ...real,
    saveJsonFile: (...args: Parameters<typeof real.saveJsonFile>) => {
      if (saveFails.on) throw new Error('disk full')
      return real.saveJsonFile(...args)
    },
  }
})

import { createNicknameStore } from '../../src/nickname-store'

let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'nick-')), 'n.json')
  saveFails.on = false
})

describe('global nickname store', () => {
  it('add/list normalized + deduped', () => {
    const s = createNicknameStore(file)
    expect(s.add('Клешня').status).toBe('added')
    expect(s.add('клешня ').status).toBe('exists')
    expect(s.list()).toEqual(['клешня'])
  })

  it('rejects too-short (min 3)', () => {
    const s = createNicknameStore(file)
    expect(s.add('я').status).toBe('too_short')
    expect(s.add('ав').status).toBe('too_short')
    expect(s.list()).toEqual([])
  })

  it('rejects reserved generic words', () => {
    const s = createNicknameStore(file)
    expect(s.add('бот').status).toBe('reserved')
    expect(s.add('Ага').status).toBe('reserved')
    expect(s.list()).toEqual([])
  })

  it('cap (50)', () => {
    const s = createNicknameStore(file)
    for (let i = 0; i < 60; i++) s.add(`имя${i}`)
    expect(s.list().length).toBe(50)
    expect(s.add('ещёодно').status).toBe('cap')
  })

  it('remove existing → removed, missing → not_found', () => {
    const s = createNicknameStore(file)
    s.add('Клешня')
    expect(s.remove('нет такого').status).toBe('not_found')
    expect(s.remove('КЛЕШНЯ').status).toBe('removed')
    expect(s.list()).toEqual([])
  })

  it('add reports persist_failed when the write throws and keeps the name until restart', () => {
    // A path whose parent is a regular file: neither the lock nor the JSON can
    // be written there.
    const blocker = join(mkdtempSync(join(tmpdir(), 'nick-')), 'blocker')
    writeFileSync(blocker, 'x')
    const s = createNicknameStore(join(blocker, 'n.json'), { info() {}, warn() {}, error() {} })
    expect(s.add('Клешня').status).toBe('persist_failed')
    expect(s.list()).toEqual(['клешня'])
  })

  it('remove reports persist_failed when the write throws', () => {
    const s = createNicknameStore(file, { info() {}, warn() {}, error() {} })
    s.add('Клешня')
    saveFails.on = true
    expect(s.remove('Клешня').status).toBe('persist_failed')
  })

  it('two store instances on one file keep both names', () => {
    const gate = createNicknameStore(file)
    const tools = createNicknameStore(file)
    expect(gate.add('Альфа').status).toBe('added')
    expect(tools.add('Бета').status).toBe('added')
    expect(createNicknameStore(file).list()).toEqual(['альфа', 'бета'])
  })

  it('leaves no lock file behind', () => {
    createNicknameStore(file).add('Клешня')
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  it('reports busy and changes nothing while another process holds the lock', () => {
    const s = createNicknameStore(file, { info() {}, warn() {}, error() {} })
    writeFileSync(`${file}.lock`, '')
    expect(s.add('Клешня').status).toBe('busy')
    expect(s.list()).toEqual([])
  })

  it('takes over a lock left by a process that died', () => {
    const s = createNicknameStore(file)
    writeFileSync(`${file}.lock`, '')
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${file}.lock`, old, old)
    expect(s.add('Клешня').status).toBe('added')
    expect(existsSync(`${file}.lock`)).toBe(false)
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

  it('re-normalizes, dedupes, floors and drops reserved words on load', () => {
    writeFileSync(file, JSON.stringify({ nicknames: ['  КЛЕШНЯ  ', 'я', 'бот', 'клешня', 'БД  Бот'] }))
    expect(createNicknameStore(file).list()).toEqual(['клешня', 'бд бот'])
  })

  it('corrupt JSON → empty, logs error', () => {
    writeFileSync(file, '{ this is not json')
    const errors: string[] = []
    const s = createNicknameStore(file, { info() {}, warn() {}, error: (m) => errors.push(m) })
    expect(s.list()).toEqual([])
    expect(errors.some((m) => m.includes('not valid JSON'))).toBe(true)
  })

  it('unexpected shape → empty, logs warn', () => {
    writeFileSync(file, JSON.stringify({ nicknames: 'oops' }))
    const warns: string[] = []
    const s = createNicknameStore(file, { info() {}, warn: (m) => warns.push(m), error() {} })
    expect(s.list()).toEqual([])
    expect(warns.some((m) => m.includes('unexpected shape'))).toBe(true)
  })
})

describe('global nickname store — cross-instance disk sync', () => {
  it('a second live instance sees a nickname added by another (no reopen)', () => {
    const gate = createNicknameStore(file)
    const tool = createNicknameStore(file)
    expect(gate.matches('Клешня, привет')).toBe(false)
    expect(tool.add('Клешня').status).toBe('added')
    expect(gate.matches('Клешня, привет')).toBe(true)
    expect(gate.list()).toEqual(['клешня'])
  })

  it('add() merges with a concurrent addition instead of clobbering it', () => {
    const a = createNicknameStore(file)
    const b = createNicknameStore(file)
    expect(a.add('Клешня').status).toBe('added')
    expect(b.add('Лобстер').status).toBe('added')
    expect(createNicknameStore(file).list()).toEqual(['клешня', 'лобстер'])
  })
})
