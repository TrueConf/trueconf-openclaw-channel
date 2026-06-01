import { describe, it, expect } from 'vitest'
import { formatQuotedPrefix } from '../../src/reply-context'

describe('formatQuotedPrefix', () => {
  it('builds a Russian quoted-context block', () => {
    expect(formatQuotedPrefix('Иван', 'Привет, как дела?')).toBe(
      '[В ответ на сообщение от Иван: «Привет, как дела?»]',
    )
  })

  it('collapses whitespace', () => {
    expect(formatQuotedPrefix('Иван', '  с1\n\nс2  ')).toBe('[В ответ на сообщение от Иван: «с1 с2»]')
  })

  it('truncates long quotes', () => {
    const out = formatQuotedPrefix('Иван', 'я'.repeat(600))
    expect(out.length).toBeLessThan(560)
    expect(out.endsWith('…»]')).toBe(true)
  })

  it('neutral author fallback', () => {
    expect(formatQuotedPrefix('', 'текст')).toBe('[В ответ на сообщение от участника: «текст»]')
  })
})
