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
    select: async () => (select.length > 0 ? select.shift() : ''),
    multiselect: async () => [],
    confirm: async () => (confirm.length > 0 ? Boolean(confirm.shift()) : true),
    progress: () => ({ update: () => {}, stop: () => {} }),
    password: async () => password.shift() ?? '',
  } as unknown as WizardPrompter
}
