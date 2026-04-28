import type { WizardPrompter } from 'openclaw/plugin-sdk/setup'

export interface FakePrompterScript {
  textResponses?: string[]
  selectResponses?: unknown[]
  passwordResponses?: string[]
  confirmResponses?: boolean[]
}

// FIFO queues — returns first unused scripted response per method, or a safe
// default ('' for text/select, true for confirm) once the queue is drained.
// The `password` method does not exist on WizardPrompter today (the SDK has no
// hidden-input primitive yet) but we expose it here so the finalize retry loop
// — which currently falls back to prompter.text() — can migrate seamlessly
// when the SDK adds it. Tests that drive the retry loop should populate
// `textResponses` today.
export function makeFakePrompter(script: FakePrompterScript = {}): WizardPrompter {
  const text = [...(script.textResponses ?? [])]
  const select = [...(script.selectResponses ?? [])]
  const password = [...(script.passwordResponses ?? [])]
  const confirm = [...(script.confirmResponses ?? [])]

  return {
    intro: async () => {},
    outro: async () => {},
    note: async () => {},
    text: async () => text.shift() ?? '',
    // Auto-handle the bin's language prompt (env+cfg empty fresh path) so
    // existing tests don't need to thread an 'en' / 'ru' response through
    // every selectResponses script. We detect it by the option shape: a
    // select with values { 'en', 'ru' } is unambiguously the language picker
    // (no other prompt in the wizard uses both 'en' and 'ru' as values).
    select: async (opts?: { options?: ReadonlyArray<{ value: unknown }> }) => {
      const values = opts?.options?.map((o) => o.value) ?? []
      const isLanguagePrompt = values.includes('en') && values.includes('ru')
      if (isLanguagePrompt) return 'en'
      return select.length > 0 ? select.shift() : ''
    },
    multiselect: async () => [],
    confirm: async () => (confirm.length > 0 ? Boolean(confirm.shift()) : true),
    progress: () => ({ update: () => {}, stop: () => {} }),
    password: async () => password.shift() ?? '',
  } as unknown as WizardPrompter
}
