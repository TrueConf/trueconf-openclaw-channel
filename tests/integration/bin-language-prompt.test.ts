import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface SelectCall { message: string; options: Array<{ value: string; label?: string }> }
interface NoteCall { msg: string; title?: string }

interface FakePrompter {
  select: (opts: { message: string; options: Array<{ value: string; label?: string }> }) => Promise<unknown>
  note: (msg: string, title?: string) => Promise<void>
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean>
  text: (opts: { message: string; placeholder?: string; initialValue?: string; validate?: (v: string) => string | undefined }) => Promise<string>
  password: (opts: { message: string; validate?: (v: string) => string | undefined }) => Promise<string>
  intro: (msg: string) => Promise<void>
  outro: (msg: string) => Promise<void>
  multiselect: (opts: unknown) => Promise<unknown[]>
  progress: (opts?: { message?: string }) => { update: (msg?: string) => void; stop: (msg?: string) => void }
}

interface PrompterCalls {
  selects: SelectCall[]
  notes: NoteCall[]
}

// Build a fake prompter that records calls and lets the caller halt the
// flow via a sentinel error when a particular select is hit. We don't run
// the full wizard — only enough to verify whether the language prompt
// appears (or doesn't).
function makeFakePrompter(opts: {
  onSelect: (call: SelectCall) => unknown | Promise<unknown>
}): { prompter: FakePrompter; calls: PrompterCalls } {
  const calls: PrompterCalls = { selects: [], notes: [] }
  const prompter: FakePrompter = {
    intro: async () => {},
    outro: async () => {},
    note: async (msg, title) => { calls.notes.push({ msg, title }) },
    text: async () => '',
    password: async () => '',
    confirm: async () => true,
    select: async (o) => {
      const call = { message: o.message, options: o.options }
      calls.selects.push(call)
      return await opts.onSelect(call)
    },
    multiselect: async () => [],
    progress: () => ({ update: () => {}, stop: () => {} }),
  }
  return { prompter, calls }
}

const HALT = 'TEST_HALT_AFTER_FIRST_SELECT'

describe('bin: language prompt', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-lang-'))
    configPath = join(tmpDir, 'openclaw.json')
    delete process.env.TRUECONF_SETUP_LOCALE
    delete process.env.TRUECONF_SERVER_URL
    delete process.env.TRUECONF_USERNAME
    delete process.env.TRUECONF_PASSWORD
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TRUECONF_SETUP_LOCALE
  })

  it('shows language prompt when env empty + cfg has no setupLocale', async () => {
    writeFileSync(configPath, JSON.stringify({}, null, 2))
    const { prompter, calls } = makeFakePrompter({
      onSelect: () => { throw new Error(HALT) },
    })

    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; prompter: FakePrompter }) => Promise<void>
    }
    await expect(runSetup({ configPath, prompter })).rejects.toThrow(HALT)

    const langPrompt = calls.selects.find((c) =>
      c.options.some((o) => o.value === 'en') && c.options.some((o) => o.value === 'ru'),
    )
    expect(langPrompt).toBeDefined()
    expect(langPrompt!.options.map((o) => o.value).sort()).toEqual(['en', 'ru'])
  })

  it('skips language prompt when TRUECONF_SETUP_LOCALE=ru set', async () => {
    process.env.TRUECONF_SETUP_LOCALE = 'ru'
    writeFileSync(configPath, JSON.stringify({}, null, 2))
    const { prompter, calls } = makeFakePrompter({
      onSelect: () => { throw new Error(HALT) },
    })

    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; prompter: FakePrompter }) => Promise<void>
    }
    // Swallow any flow error after the locale phase; we only inspect select calls.
    await runSetup({ configPath, prompter }).catch(() => {})

    const langPrompt = calls.selects.find((c) =>
      c.options.some((o) => o.value === 'en') && c.options.some((o) => o.value === 'ru'),
    )
    expect(langPrompt).toBeUndefined()
  })

  it('skips language prompt when cfg.channels.trueconf.setupLocale=ru', async () => {
    writeFileSync(configPath, JSON.stringify({
      channels: { trueconf: { setupLocale: 'ru' } },
    }, null, 2))
    const { prompter, calls } = makeFakePrompter({
      onSelect: () => { throw new Error(HALT) },
    })

    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; prompter: FakePrompter }) => Promise<void>
    }
    // cfg has setupLocale → wizard would prompt overwrite-confirm next; we
    // just need to confirm the LANGUAGE prompt did not fire. Swallow all
    // post-locale errors.
    await runSetup({ configPath, prompter }).catch(() => {})

    const langPrompt = calls.selects.find((c) =>
      c.options.some((o) => o.value === 'en') && c.options.some((o) => o.value === 'ru'),
    )
    expect(langPrompt).toBeUndefined()
  })

  it('selected en propagates to wizard intro (English)', async () => {
    writeFileSync(configPath, JSON.stringify({}, null, 2))
    const seenNotes: string[] = []
    const { prompter } = makeFakePrompter({
      onSelect: (call) => {
        // First select = language prompt — pick en, then halt the next select
        if (call.options.some((o) => o.value === 'en') && call.options.some((o) => o.value === 'ru')) {
          return 'en'
        }
        throw new Error(HALT)
      },
    })
    // Wire note recording into the prompter we just made
    const recordingPrompter: FakePrompter = {
      ...prompter,
      note: async (msg, title) => {
        if (title) seenNotes.push(`${title}\n${msg}`)
        else seenNotes.push(msg)
      },
    }

    const { runSetup } = await import('../../bin/trueconf-setup.mjs') as {
      runSetup: (opts: { configPath: string; prompter: FakePrompter }) => Promise<void>
    }
    // After locale=en, the next prompt is text() for serverUrl which throws
    // "field required" — swallow it; we only inspect the intro note that ran
    // before the throw.
    await runSetup({ configPath, prompter: recordingPrompter }).catch(() => {})

    const introNote = seenNotes.find((n) => /trueconf/i.test(n))
    expect(introNote).toBeDefined()
    // After locale=en selected, intro note title should be English ("Connect"),
    // not Russian ("Подключение").
    expect(introNote!).toMatch(/connect.*trueconf/i)
    expect(introNote!).not.toMatch(/Подключение/)
  })
})
