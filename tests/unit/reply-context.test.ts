import { describe, it, expect, vi } from 'vitest'
import { fetchQuotedContext, formatQuotedPrefix } from '../../src/reply-context'

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

const wsOf = (resp: unknown, o: { throws?: boolean; delayMs?: number } = {}) =>
  ({
    sendRequest: async () => {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs))
      if (o.throws) throw new Error('net')
      return resp
    },
  }) as never

describe('fetchQuotedContext', () => {
  it('text quote → prefix', async () => {
    const ws = wsOf({ payload: { type: 200, author: { id: 'ivan@s' }, content: { text: 'Привет', parseMode: 'text' } } })
    expect(await fetchQuotedContext(ws, 'm', () => 'Иван', null)).toBe('[В ответ на сообщение от Иван: «Привет»]')
  })

  it('strips html', async () => {
    const ws = wsOf({ payload: { type: 200, author: { id: 'a' }, content: { text: '<b>ж</b> т', parseMode: 'html' } } })
    expect(await fetchQuotedContext(ws, 'm', () => 'A', null)).toBe('[В ответ на сообщение от A: «ж т»]')
  })

  it('errorCode → null', async () => {
    expect(await fetchQuotedContext(wsOf({ payload: { errorCode: 306 } }), 'm', () => 'A', null)).toBeNull()
  })

  it('throw → null', async () => {
    expect(await fetchQuotedContext(wsOf(null, { throws: true }), 'm', () => 'A', null)).toBeNull()
  })

  it('non-text type → null', async () => {
    expect(
      await fetchQuotedContext(wsOf({ payload: { type: 202, author: { id: 'a' }, content: {} } }), 'm', () => 'A', null),
    ).toBeNull()
  })

  it('timeout → null', async () => {
    const ws = wsOf({ payload: { type: 200, author: { id: 'a' }, content: { text: 'x', parseMode: 'text' } } }, { delayMs: 50 })
    expect(await fetchQuotedContext(ws, 'm', () => 'A', null, 10)).toBeNull()
  })

  it('PLAIN_MESSAGE without text → null, warns (schema-drift canary)', async () => {
    const warn = vi.fn()
    const ws = wsOf({ payload: { type: 200, author: { id: 'a' }, content: {} } })
    expect(await fetchQuotedContext(ws, 'm', () => 'A', { warn })).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('content.text'))
  })

  it('timeout logs a warning', async () => {
    const warn = vi.fn()
    const ws = wsOf({ payload: { type: 200, author: { id: 'a' }, content: { text: 'x', parseMode: 'text' } } }, { delayMs: 50 })
    expect(await fetchQuotedContext(ws, 'm', () => 'A', { warn }, 10)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })
})
