import { describe, expect, it } from 'vitest'
import { t, DEFAULT_LOCALE, TRANSLATION_KEYS } from '../../src/i18n'

describe('i18n', () => {
  it('returns English by default', () => {
    expect(DEFAULT_LOCALE).toBe('en')
  })

  it('returns Russian when locale=ru', () => {
    expect(t('tls.cafile.hint.intro', 'ru')).toMatch(/[А-Яа-я]/)
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

  it('ephemeral-host error interpolates path + npmSpec (en + ru)', () => {
    const vars = { path: '/u/.npm/_npx/x/p', npmSpec: '@trueconf-community/trueconf-openclaw-channel' }
    const en = t('bin.ephemeralHost.error', 'en', vars)
    expect(en).toMatch(/\/u\/\.npm\/_npx\/x\/p/)
    expect(en).toContain('openclaw plugins install @trueconf-community/trueconf-openclaw-channel')
    const ru = t('bin.ephemeralHost.error', 'ru', vars)
    expect(ru).toMatch(/[А-Яа-я]/)
    expect(ru).toContain('/u/.npm/_npx/x/p')
    expect(ru).toContain('npx -y -p @trueconf-community/trueconf-openclaw-channel trueconf-setup')
  })
})
