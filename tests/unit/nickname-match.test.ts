import { describe, it, expect } from 'vitest'
import { matchesAnyNickname, normalizeNickname } from '../../src/nickname-match'

describe('normalizeNickname', () => {
  it('lower+trim', () => expect(normalizeNickname('  Клешня ')).toBe('клешня'))
  it('collapse spaces', () => expect(normalizeNickname('БД   Бот')).toBe('бд бот'))
})

describe('matchesAnyNickname', () => {
  const set = ['клешня', 'бд бот']

  it('whole word anywhere, ci', () => {
    expect(matchesAnyNickname('а что думает Клешня?', set)).toBe(true)
    expect(matchesAnyNickname('КЛЕШНЯ глянь', set)).toBe(true)
  })

  it('not a substring', () => {
    expect(matchesAnyNickname('это клешнятина', set)).toBe(false)
  })

  it('multiword variable spacing', () => expect(matchesAnyNickname('эй, БД   Бот!', set)).toBe(true))

  it('punctuation boundaries', () => expect(matchesAnyNickname('(клешня)', set)).toBe(true))

  it('empty set/text', () => {
    expect(matchesAnyNickname('клешня', [])).toBe(false)
    expect(matchesAnyNickname('', set)).toBe(false)
  })

  it('treats an adjacent digit as a boundary', () => {
    expect(matchesAnyNickname('бот3000', ['бот'])).toBe(false)
  })

  it('escapes regex metacharacters in the nickname', () => {
    expect(matchesAnyNickname('позвать чат.бот сюда', ['чат.бот'])).toBe(true)
    expect(matchesAnyNickname('чатXбот', ['чат.бот'])).toBe(false)
  })
})
