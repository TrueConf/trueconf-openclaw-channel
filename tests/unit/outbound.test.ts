import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileUploadLimits, TEXT_LIMIT, type ValidationResult } from '../../src/limits'
import { PerChatSendQueue } from '../../src/send-queue'
import { OutboundQueue, type WsClientLike } from '../../src/outbound-queue'
import type { Logger, TrueConfChannelConfig, TrueConfResponse } from '../../src/types'

// Mock the SDK module before importing outbound: outbound.ts pulls
// `loadOutboundMediaFromUrl` at top level, so we need the mock in place
// before any test imports it.
vi.mock('../../src/load-media', () => ({
  loadOutboundMediaFromUrl: vi.fn(),
}))

vi.mock('openclaw/plugin-sdk/media-runtime', () => ({
  kindFromMime: (mime: string) => {
    if (mime.startsWith('image/')) return 'image'
    return 'document'
  },
}))

vi.mock('sharp', () => ({
  default: () => ({
    resize: () => ({
      webp: () => ({
        toBuffer: async () => Buffer.from([0x57, 0x45, 0x42, 0x50]),
      }),
    }),
  }),
}))

import { loadOutboundMediaFromUrl } from '../../src/load-media'
import {
  sendText,
  sendTextToChat,
  handleOutboundAttachment,
  handleOutboundAttachmentToChat,
  sanitizeMarkdown,
  sanitizeMarkdownPreservingParagraphs,
  type DirectChatStore,
  type OutboundAttachmentDeps,
  type OutboundAttachmentToChatDeps,
  __test__buildSendFilePayload,
  __test__sendMessageRequest,
} from '../../src/outbound'

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function makeDeferred<T = TrueConfResponse>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (err: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function ok(messageId = 'm-1'): TrueConfResponse {
  return { type: 2, id: 1, payload: { errorCode: 0, messageId } }
}

function fail(errorCode: number, errorDescription = ''): TrueConfResponse {
  return { type: 2, id: 1, payload: { errorCode, errorDescription } }
}

interface FakeWsClient extends WsClientLike {
  sendRequest: ReturnType<typeof vi.fn>
  onAuth: (listener: () => void) => () => void
}

function buildFakeClient(impl?: (method: string, payload: Record<string, unknown>) => Promise<TrueConfResponse>): FakeWsClient {
  return {
    sendRequest: vi.fn(impl ?? (async () => ok())),
    // OutboundQueue subscribes to auth events to trigger drain. Tests don't
    // exercise reconnect flows here, so a no-op subscription is sufficient.
    onAuth: () => () => {},
  }
}

function buildOutboundQueue(client: FakeWsClient, logger: Logger = silentLogger): OutboundQueue {
  return new OutboundQueue(client, logger)
}

function buildStore(): DirectChatStore {
  return { directChatsByStableUserId: new Map<string, string>() }
}

function buildLimits(opts?: { staticMaxBytes?: number }): FileUploadLimits {
  return new FileUploadLimits(opts?.staticMaxBytes ?? 50 * 1024 * 1024)
}

function buildChannelConfig(): TrueConfChannelConfig {
  return { serverUrl: 'tc.example.com', username: 'bot', password: 'pw', useTls: true } as TrueConfChannelConfig
}

function buildAttachmentDeps(
  overrides: Partial<OutboundAttachmentDeps> & { client?: FakeWsClient } = {},
): OutboundAttachmentDeps {
  // `client` is a test-only shorthand: build the OutboundQueue around this
  // fake client. Not a field on OutboundAttachmentDeps; keeps existing tests
  // succinct without leaking a wsClient dep field that the production type
  // no longer carries.
  const { client, ...depsOverrides } = overrides
  const fakeClient = client ?? buildFakeClient()
  return {
    outboundQueue: overrides.outboundQueue ?? buildOutboundQueue(fakeClient),
    resolved: { serverUrl: 'tc.example.com', useTls: true, port: 443 },
    store: buildStore(),
    channelConfig: buildChannelConfig(),
    logger: silentLogger,
    limits: buildLimits(),
    sendQueue: new PerChatSendQueue(),
    ...depsOverrides,
  }
}

beforeEach(() => {
  vi.mocked(loadOutboundMediaFromUrl).mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('sanitizeMarkdownPreservingParagraphs', () => {
  it('preserves single \\n\\n paragraph break', () => {
    const out = sanitizeMarkdownPreservingParagraphs('para1\n\npara2')
    expect(out).toBe('para1\n\npara2')
  })

  it('collapses 3+ consecutive newlines down to \\n\\n', () => {
    const out = sanitizeMarkdownPreservingParagraphs('a\n\n\n\nb')
    expect(out).toBe('a\n\nb')
  })

  it('keeps single newlines untouched', () => {
    const out = sanitizeMarkdownPreservingParagraphs('line1\nline2')
    expect(out).toBe('line1\nline2')
  })

  it('still strips inline emphasis like sanitizeMarkdown', () => {
    const out = sanitizeMarkdownPreservingParagraphs('**bold** text')
    expect(out).toBe('bold text')
  })
})

describe('sendMessageRequest auto-split + sendQueue', () => {
  it('text < TEXT_LIMIT → single sendMessage call → returns one response', async () => {
    const client = buildFakeClient(async () => ok('m-1'))
    const outboundQueue = buildOutboundQueue(client)
    const queue = new PerChatSendQueue()

    const responses = await __test__sendMessageRequest(
      outboundQueue,
      'chat-X',
      'short text',
      queue,
    )

    expect(responses).toHaveLength(1)
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).toHaveBeenCalledWith('sendMessage', {
      chatId: 'chat-X',
      content: { text: 'short text', parseMode: 'markdown' },
    }, expect.any(String))
  })

  it('multi-chunk: halts on first error, returns partial array', async () => {
    let call = 0
    const client = buildFakeClient(async () => {
      call += 1
      if (call === 1) return ok('m-1')
      if (call === 2) return fail(500, 'server error')
      return ok('m-3')
    })
    const outboundQueue = buildOutboundQueue(client)
    const queue = new PerChatSendQueue()

    // Build a text large enough to produce >=3 chunks. TEXT_LIMIT default is 4096.
    // Three paragraphs each TEXT_LIMIT-1 chars long, joined with `\n\n`, will split
    // into 3 chunks.
    const para = 'a'.repeat(TEXT_LIMIT - 1)
    const big = `${para}\n\n${para}\n\n${para}`

    const responses = await __test__sendMessageRequest(
      outboundQueue,
      'chat-X',
      big,
      queue,
    )

    expect(responses).toHaveLength(2)
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('two parallel sendText calls to same chatId serialize through sendQueue', async () => {
    const dA = makeDeferred<TrueConfResponse>()
    const calls: string[] = []
    const client = buildFakeClient(async (_method, payload) => {
      calls.push(`call:${(payload as { chatId: string }).chatId}`)
      // First call awaits dA; subsequent calls return immediately.
      if (calls.length === 1) return dA.promise
      return ok('m-' + calls.length)
    })
    const outboundQueue = buildOutboundQueue(client)
    const queue = new PerChatSendQueue()

    const p1 = sendTextToChat(outboundQueue, 'chat-X', 'first', silentLogger, queue)
    const p2 = sendTextToChat(outboundQueue, 'chat-X', 'second', silentLogger, queue)

    // Let microtasks settle so the first sendRequest fires.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(client.sendRequest).toHaveBeenCalledTimes(1)

    // Resolve the first call. Now the second should fire.
    dA.resolve(ok('m-1'))
    await p1
    await p2

    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })
})

describe('buildSendFilePayload omits replyMessageId:null', () => {
  it('does not include replyMessageId key when upload.replyMessageId is null', () => {
    const upload = {
      temporalFileId: 'tfid-1',
      inlineCaption: null as string | null,
      kind: 'document' as const,
      bytes: 100,
      replyMessageId: null as string | null,
    }
    const payload = __test__buildSendFilePayload('chat-X', upload)
    expect(Object.keys(payload).includes('replyMessageId')).toBe(false)
    expect(payload.chatId).toBe('chat-X')
  })

  it('includes replyMessageId when non-null', () => {
    const upload = {
      temporalFileId: 'tfid-1',
      inlineCaption: null as string | null,
      kind: 'document' as const,
      bytes: 100,
      replyMessageId: 'reply-id-7',
    }
    const payload = __test__buildSendFilePayload('chat-X', upload)
    expect(payload.replyMessageId).toBe('reply-id-7')
  })
})

describe('handleOutboundAttachment caption flow', () => {
  function setupGenericMock(opts: {
    fileSize?: number
    fileName?: string
    mimeType?: string
  } = {}): void {
    vi.mocked(loadOutboundMediaFromUrl).mockResolvedValue({
      buffer: Buffer.alloc(opts.fileSize ?? 100),
      contentType: opts.mimeType ?? 'application/pdf',
      kind: 'document',
      fileName: opts.fileName ?? 'doc.pdf',
    } as never)
  }

  it('caption > CAPTION_LIMIT: caption sent as separate sendMessage, sendFile then has no caption', async () => {
    setupGenericMock()

    // Provide a successful uploadFile, multipart upload, then sendMessage(caption) ok, sendFile ok.
    const calls: { method: string; payload: Record<string, unknown> }[] = []
    const client = buildFakeClient(async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'uploadFile') {
        return { type: 2, id: 1, payload: { errorCode: 0, uploadTaskId: 'task-1' } }
      }
      if (method === 'createP2PChat') {
        return { type: 2, id: 1, payload: { errorCode: 0, chatId: 'chat-direct' } }
      }
      if (method === 'sendMessage') return ok('m-cap')
      if (method === 'sendFile') return ok('m-file')
      return ok('m-x')
    })

    // Stub the multipart upload by intercepting global fetch.
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ temporalFileId: 'tf-abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    try {
      const longCaption = 'x'.repeat(5000)
      const deps = buildAttachmentDeps({ client })
      const result = await handleOutboundAttachment(
        { to: 'alice@srv', text: longCaption, mediaUrl: 'file:///tmp/doc.pdf', accountId: 'default' },
        deps,
      )

      expect(result.ok).toBe(true)

      const sendMessageIdx = calls.findIndex((c) => c.method === 'sendMessage')
      const sendFileIdx = calls.findIndex((c) => c.method === 'sendFile')
      expect(sendMessageIdx).toBeGreaterThanOrEqual(0)
      expect(sendFileIdx).toBeGreaterThanOrEqual(0)
      expect(sendMessageIdx).toBeLessThan(sendFileIdx)

      const sendFileCall = calls[sendFileIdx]!
      const content = (sendFileCall.payload.content as { caption?: unknown })
      // caption MUST be absent (or empty) when caption was sent separately.
      expect(content.caption).toBeUndefined()
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('FileUploadLimits reject (too_large): userFacingText contains both limit MB and actual MB', async () => {
    setupGenericMock({ fileSize: 50_000_000 })

    const limits = new FileUploadLimits(2 * 1024 * 1024 * 1024) // 2 GB raw cap (so loadOutboundMediaFromUrl doesn't refuse)
    // Override validateFile + getMaxBytes to force a 'too_large' rejection.
    const validateFileMock = vi.fn<(name: string, size: number) => ValidationResult>(() => ({
      ok: false,
      reason: 'too_large',
      detail: '50000000 > 1000000',
    }))
    const getMaxBytesMock = vi.fn<() => number>(() => 1_000_000)
    ;(limits as unknown as { validateFile: typeof validateFileMock }).validateFile = validateFileMock
    ;(limits as unknown as { getMaxBytes: typeof getMaxBytesMock }).getMaxBytes = getMaxBytesMock

    const calls: { method: string; payload: Record<string, unknown> }[] = []
    const client = buildFakeClient(async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'createP2PChat') {
        return { type: 2, id: 1, payload: { errorCode: 0, chatId: 'chat-direct' } }
      }
      if (method === 'sendMessage') return ok('m-err')
      return ok('m-x')
    })

    const deps = buildAttachmentDeps({ client, limits })
    const result = await handleOutboundAttachment(
      { to: 'alice@srv', text: '', mediaUrl: 'file:///tmp/big.bin', accountId: 'default' },
      deps,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return // type guard

    // The caller surfaces userFacingText to the user via sendText. Inspect the
    // sendMessage payload that fail() routed through.
    const userMessage = calls.find((c) => c.method === 'sendMessage')
    expect(userMessage).toBeDefined()
    const text = (userMessage!.payload.content as { text: string }).text
    // 1_000_000 bytes → ceil(1_000_000 / 1024 / 1024) = 1 MB
    // 50_000_000 bytes → ceil(50_000_000 / 1024 / 1024) = 48 MB
    expect(text).toContain('1')
    expect(text).toContain('48')
  })

  it('caption split + sendFile failure: explicit orphan error log', async () => {
    setupGenericMock()

    const calls: { method: string; payload: Record<string, unknown> }[] = []
    const client = buildFakeClient(async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'uploadFile') {
        return { type: 2, id: 1, payload: { errorCode: 0, uploadTaskId: 'task-1' } }
      }
      if (method === 'createP2PChat') {
        return { type: 2, id: 1, payload: { errorCode: 0, chatId: 'chat-direct' } }
      }
      if (method === 'sendMessage') return ok('m-cap')
      if (method === 'sendFile') return fail(500, 'oh no')
      return ok('m-x')
    })

    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ temporalFileId: 'tf-abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    const errorMessages: string[] = []
    const captureLogger: Logger = {
      info: () => {},
      warn: () => {},
      error: (m: string) => { errorMessages.push(m) },
    }

    try {
      const longCaption = 'x'.repeat(5000)
      const deps = buildAttachmentDeps({ client, logger: captureLogger })
      const result = await handleOutboundAttachment(
        { to: 'alice@srv', text: longCaption, mediaUrl: 'file:///tmp/doc.pdf', accountId: 'default' },
        deps,
      )

      expect(result.ok).toBe(false)
      const orphanLog = errorMessages.find(
        (m) => m.toLowerCase().includes('orphan') || m.includes('AFTER caption'),
      )
      expect(orphanLog).toBeDefined()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

// Smoke that previously-existing sanitizeMarkdown still collapses paragraph breaks
// (so caption path keeps the historical behavior).
describe('sanitizeMarkdown unchanged for caption use', () => {
  it('collapses \\n\\n into single newline (legacy caption behavior)', () => {
    const out = sanitizeMarkdown('para1\n\npara2')
    expect(out).toBe('para1\npara2')
  })
})

// Reference: ensure types compile.
describe('OutboundAttachmentToChatDeps Pick keys include limits and sendQueue', () => {
  it('type compiles with limits and sendQueue', () => {
    const client = buildFakeClient()
    const deps: OutboundAttachmentToChatDeps = {
      outboundQueue: buildOutboundQueue(client),
      resolved: { serverUrl: 'x', useTls: true, port: 443 },
      channelConfig: buildChannelConfig(),
      logger: silentLogger,
      limits: buildLimits(),
      sendQueue: new PerChatSendQueue(),
    }
    expect(deps.sendQueue).toBeInstanceOf(PerChatSendQueue)
    expect(deps.limits).toBeInstanceOf(FileUploadLimits)
  })
})

// Make sure sendText still works with the queue argument plumbed through deps.
describe('sendText/sendTextToChat plumb queue', () => {
  it('sendText returns last response messageId after multi-chunk send', async () => {
    let call = 0
    const client = buildFakeClient(async () => {
      call += 1
      // P2P chat creation comes first.
      if (call === 1) {
        return { type: 2, id: 1, payload: { errorCode: 0, chatId: 'chat-id' } }
      }
      if (call === 2) return ok('m-1')
      return ok('m-2')
    })
    const outboundQueue = buildOutboundQueue(client)
    const queue = new PerChatSendQueue()
    const result = await sendText(
      'alice@srv',
      'simple text',
      silentLogger,
      {
        fallbackUserId: 'alice@srv',
        directChatStore: buildStore(),
        accountId: 'default',
        sendQueue: queue,
        outboundQueue,
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messageId).toBe('m-1')
  })

  it('sendTextToChat returns first error and stops on multi-chunk halt', async () => {
    let call = 0
    const client = buildFakeClient(async () => {
      call += 1
      if (call === 1) return ok('m-1')
      return fail(500, 'server error')
    })
    const outboundQueue = buildOutboundQueue(client)
    const queue = new PerChatSendQueue()
    const para = 'a'.repeat(TEXT_LIMIT - 1)
    const big = `${para}\n\n${para}\n\n${para}`
    const result = await sendTextToChat(outboundQueue, 'chat-X', big, silentLogger, queue)
    expect(result.ok).toBe(false)
    expect(call).toBe(2)
  })
})

// Double-check that handleOutboundAttachmentToChat plumbs deps correctly (compile + smoke).
describe('handleOutboundAttachmentToChat happy path', () => {
  it('returns ok when sendFile resolves with messageId', async () => {
    vi.mocked(loadOutboundMediaFromUrl).mockResolvedValue({
      buffer: Buffer.alloc(50),
      contentType: 'application/pdf',
      kind: 'document',
      fileName: 'doc.pdf',
    } as never)

    const client = buildFakeClient(async (method) => {
      if (method === 'uploadFile') {
        return { type: 2, id: 1, payload: { errorCode: 0, uploadTaskId: 'task-1' } }
      }
      if (method === 'sendFile') return ok('m-file')
      return ok('m-x')
    })

    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ temporalFileId: 'tf-abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    try {
      const deps: OutboundAttachmentToChatDeps = {
        outboundQueue: buildOutboundQueue(client),
        resolved: { serverUrl: 'tc.example.com', useTls: true, port: 443 },
        channelConfig: buildChannelConfig(),
        logger: silentLogger,
        limits: buildLimits(),
        sendQueue: new PerChatSendQueue(),
      }
      const result = await handleOutboundAttachmentToChat(
        { chatId: 'chat-X', text: 'short caption', mediaUrl: 'file:///tmp/doc.pdf' },
        deps,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.messageId).toBe('m-file')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
