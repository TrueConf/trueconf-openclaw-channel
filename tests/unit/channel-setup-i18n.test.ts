import { describe, it, expect } from 'vitest'
import { buildSetupWizardDescriptor, trueconfSetupWizard } from '../../src/channel-setup'
import { t } from '../../src/i18n'

const findInput = <T extends { inputKey: string }>(
  inputs: readonly T[] | undefined,
  key: string,
): T => {
  const found = inputs?.find((i) => i.inputKey === key)
  if (!found) throw new Error(`input ${key} not found`)
  return found
}

describe('buildSetupWizardDescriptor(t, locale)', () => {
  it('returns localized intro for en', () => {
    const d = buildSetupWizardDescriptor(t, 'en')
    expect(d.introNote!.title).toMatch(/connect.*trueconf/i)
    expect(d.introNote!.lines.join(' ')).toMatch(/server URL.*login.*password/i)
  })

  it('returns localized intro for ru', () => {
    const d = buildSetupWizardDescriptor(t, 'ru')
    expect(d.introNote!.title).toMatch(/Подключение к TrueConf/)
    expect(d.introNote!.lines.join(' ')).toMatch(/адрес сервера.*логин.*пароль/)
  })

  it('localizes status labels', () => {
    const en = buildSetupWizardDescriptor(t, 'en').status
    const ru = buildSetupWizardDescriptor(t, 'ru').status
    expect(en.configuredLabel).toMatch(/connected/i)
    expect(en.unconfiguredLabel).toMatch(/credentials/i)
    expect(ru.configuredLabel).toMatch(/подключён/)
    expect(ru.unconfiguredLabel).toMatch(/нужны креды/)
  })

  it('localizes envShortcut prompt', () => {
    const en = buildSetupWizardDescriptor(t, 'en').envShortcut!.prompt
    const ru = buildSetupWizardDescriptor(t, 'ru').envShortcut!.prompt
    expect(en).toMatch(/detected.*automatically/i)
    expect(ru).toMatch(/обнаружены.*автоматически/)
  })

  it('localizes serverUrl validate (en)', () => {
    const d = buildSetupWizardDescriptor(t, 'en')
    const input = findInput(d.textInputs, 'serverUrl')
    const result = input.validate!({
      value: 'http://x.com', cfg: {} as never, accountId: 'default', credentialValues: {},
    })
    expect(result).toMatch(/without http/i)
  })

  it('localizes serverUrl validate (ru)', () => {
    const d = buildSetupWizardDescriptor(t, 'ru')
    const input = findInput(d.textInputs, 'serverUrl')
    const result = input.validate!({
      value: 'http://x.com', cfg: {} as never, accountId: 'default', credentialValues: {},
    })
    expect(result).toMatch(/без http/)
  })

  it('localizes serverUrl validate :port branch (en)', () => {
    const d = buildSetupWizardDescriptor(t, 'en')
    const input = findInput(d.textInputs, 'serverUrl')
    const result = input.validate!({
      value: 'tc.example.com:443', cfg: {} as never, accountId: 'default', credentialValues: {},
    })
    expect(result).toMatch(/port goes in a separate field/i)
  })

  it('localizes username message', () => {
    const en = findInput(buildSetupWizardDescriptor(t, 'en').textInputs, 'username').message
    const ru = findInput(buildSetupWizardDescriptor(t, 'ru').textInputs, 'username').message
    expect(en).toMatch(/login/i)
    expect(ru).toMatch(/Логин/)
  })

  it('localizes useTls message', () => {
    const en = findInput(buildSetupWizardDescriptor(t, 'en').textInputs, 'useTls').message
    const ru = findInput(buildSetupWizardDescriptor(t, 'ru').textInputs, 'useTls').message
    expect(en).toMatch(/auto-detect/i)
    expect(ru).toMatch(/авто-детект/)
  })

  it('localizes port message and validate', () => {
    const en = findInput(buildSetupWizardDescriptor(t, 'en').textInputs, 'port')
    const ru = findInput(buildSetupWizardDescriptor(t, 'ru').textInputs, 'port')
    expect(en.message).toMatch(/port/i)
    expect(ru.message).toMatch(/Порт/)
    const enValidate = en.validate!({
      value: 'abc', cfg: {} as never, accountId: 'default', credentialValues: {},
    })
    const ruValidate = ru.validate!({
      value: 'abc', cfg: {} as never, accountId: 'default', credentialValues: {},
    })
    expect(enValidate).toMatch(/invalid port/i)
    expect(ruValidate).toMatch(/Невалидный порт/)
  })

  it('localizes credential prompts', () => {
    const en = buildSetupWizardDescriptor(t, 'en').credentials[0]
    const ru = buildSetupWizardDescriptor(t, 'ru').credentials[0]
    expect(en.credentialLabel).toMatch(/bot password/i)
    expect(ru.credentialLabel).toMatch(/Пароль/)
    expect(en.envPrompt).toMatch(/from.*environment/i)
    expect(ru.envPrompt).toMatch(/из окружения/)
    expect(en.keepPrompt).toMatch(/Keep/i)
    expect(ru.keepPrompt).toMatch(/Оставить/)
    expect(en.inputPrompt).toMatch(/Enter.*password/i)
    expect(ru.inputPrompt).toMatch(/Введите пароль/)
  })

  it('localizes completionNote', () => {
    const en = buildSetupWizardDescriptor(t, 'en').completionNote!
    const ru = buildSetupWizardDescriptor(t, 'ru').completionNote!
    expect(en.title).toMatch(/done/i)
    expect(ru.title).toMatch(/Готово/)
    expect(en.lines.join(' ')).toMatch(/configured/i)
    expect(ru.lines.join(' ')).toMatch(/настроен/)
  })
})

describe('trueconfSetupWizard (legacy default-locale export)', () => {
  it('uses DEFAULT_LOCALE = en', () => {
    expect(trueconfSetupWizard.introNote!.title).toMatch(/connect.*trueconf/i)
  })

  it('shape unchanged: still has channel/status/textInputs/credentials', () => {
    expect(trueconfSetupWizard.channel).toBe('trueconf')
    expect(trueconfSetupWizard.status).toBeDefined()
    expect(trueconfSetupWizard.textInputs!.length).toBeGreaterThanOrEqual(4)
    expect(trueconfSetupWizard.credentials).toHaveLength(1)
  })
})
