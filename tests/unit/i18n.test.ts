import { describe, expect, it } from 'vitest'
import { t, DEFAULT_LOCALE, TRANSLATION_KEYS } from '../../src/i18n'

describe('i18n', () => {
  it('returns English by default', () => {
    expect(DEFAULT_LOCALE).toBe('en')
  })

  it('returns Russian when locale=ru', () => {
    expect(t('tls.cafile.hint', 'ru')).toMatch(/[А-Яа-я]/)
  })

  it('throws on unknown key', () => {
    expect(() => t('does.not.exist' as never, 'en')).toThrow(/unknown translation key/i)
  })

  it('every key has both en and ru entries', () => {
    for (const key of TRANSLATION_KEYS) {
      expect(typeof t(key, 'en')).toBe('string')
      expect(typeof t(key, 'ru')).toBe('string')
      expect(t(key, 'en').length).toBeGreaterThan(0)
      expect(t(key, 'ru').length).toBeGreaterThan(0)
    }
  })

  it('interpolates {{vars}}', () => {
    expect(t('tls.cafile.unreadable', 'en', { path: '/etc/ca.pem', reason: 'EACCES' }))
      .toMatch(/\/etc\/ca\.pem/)
    expect(t('tls.cafile.unreadable', 'en', { path: '/etc/ca.pem', reason: 'EACCES' }))
      .toMatch(/EACCES/)
  })
})
