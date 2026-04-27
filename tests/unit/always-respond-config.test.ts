import { describe, it, expect, vi } from 'vitest'
import { parseAlwaysRespondConfig } from '../../src/config'

function makeLogger() {
  return { warn: vi.fn() }
}

describe('parseAlwaysRespondConfig', () => {
  // 1. undefined → empty sets, no warns
  it('returns empty sets for undefined input', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(undefined, logger)
    expect(result.configuredChatIds.size).toBe(0)
    expect(result.configuredTitles.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // 1b. null → empty sets, no warns (treated like undefined per codebase convention)
  it('returns empty sets for null input without warning', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(null, logger)
    expect(result.configuredChatIds.size).toBe(0)
    expect(result.configuredTitles.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // 2. non-array → warn once, empty sets
  it('warns and returns empty sets for non-array input', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig('not an array', logger)
    expect(result.configuredChatIds.size).toBe(0)
    expect(result.configuredTitles.size).toBe(0)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toContain('must be an array')
  })

  // 3. empty array → empty sets, no warns
  it('returns empty sets for empty array', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig([], logger)
    expect(result.configuredChatIds.size).toBe(0)
    expect(result.configuredTitles.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // 4. bare string → title (trimmed + lowercased)
  it('treats bare string as title, trims and lowercases', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(['  HR Отдел  '], logger)
    expect(result.configuredTitles.has('hr отдел')).toBe(true)
    expect(result.configuredChatIds.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // 5. title: prefix → title set
  it('routes title: prefix to configuredTitles', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(['title:Support Team'], logger)
    expect(result.configuredTitles.has('support team')).toBe(true)
    expect(result.configuredChatIds.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // 6. chatId: prefix → chatId set (not lowercased)
  it('routes chatId: prefix to configuredChatIds, preserves case', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(['chatId:Room@trueconf.example'], logger)
    expect(result.configuredChatIds.has('Room@trueconf.example')).toBe(true)
    expect(result.configuredTitles.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // 7. duplicate entries → one warn per duplicate, one entry in set
  it('deduplicates entries and warns for each duplicate', () => {
    const logger = makeLogger()
    // 'hr' and 'title:HR' both normalize to title 'hr' → 1 dedup warn
    // 'chatId:Room@tc' appears twice → 1 dedup warn
    // total: 2 warns
    const result = parseAlwaysRespondConfig(
      ['hr', 'title:HR', 'chatId:Room@tc', 'chatId:Room@tc'],
      logger,
    )
    expect(result.configuredTitles.size).toBe(1)
    expect(result.configuredTitles.has('hr')).toBe(true)
    expect(result.configuredChatIds.size).toBe(1)
    expect(result.configuredChatIds.has('Room@tc')).toBe(true)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    for (const [msg] of logger.warn.mock.calls) {
      expect(msg).toContain('deduplicating')
    }
  })

  // 8. empty suffix after trim → warn and skip
  it('warns and skips entries with empty suffix after trim', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(['title:   ', 'chatId:  '], logger)
    expect(result.configuredTitles.size).toBe(0)
    expect(result.configuredChatIds.size).toBe(0)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn.mock.calls[0][0]).toContain('empty suffix')
    expect(logger.warn.mock.calls[1][0]).toContain('empty suffix')
  })

  // 9. skips non-string / empty / NUL entries
  it('skips non-string, empty, and NUL-byte entries with one warn each', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(
      ['hr', '', 123, 'bad\0chat', 'ok'],
      logger,
    )
    // 3 invalid entries: '', 123, 'bad\0chat'
    expect(logger.warn).toHaveBeenCalledTimes(3)
    const titles = [...result.configuredTitles].sort()
    expect(titles).toEqual(['hr', 'ok'])
    expect(result.configuredChatIds.size).toBe(0)
  })

  // 10. internal whitespace preserved in title
  it('preserves internal whitespace in title entries', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(
      ['HR  вопросы', 'HR вопросы'],
      logger,
    )
    // Both are distinct after trim+lowercase (internal spaces differ)
    expect(result.configuredTitles.has('hr  вопросы')).toBe(true)
    expect(result.configuredTitles.has('hr вопросы')).toBe(true)
    expect(result.configuredTitles.size).toBe(2)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // 11. bare 40-hex → title (no auto-detect)
  it('treats bare 40-hex string as title (no auto-detect)', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(
      ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
      logger,
    )
    expect([...result.configuredTitles]).toEqual(['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'])
    expect(result.configuredChatIds.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // 12. case-sensitive prefix — wrong case becomes title
  it('treats wrong-case prefix entries as titles (prefix is case-sensitive)', () => {
    const logger = makeLogger()
    const result = parseAlwaysRespondConfig(['ChatId:xyz', 'CHATID:abc'], logger)
    expect([...result.configuredTitles].sort()).toEqual(['chatid:abc', 'chatid:xyz'])
    expect(result.configuredChatIds.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
