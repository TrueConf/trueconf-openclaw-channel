import { describe, expect, it, vi } from 'vitest'
import { FileUploadLimits } from '../../src/limits'
import { PerChatSendQueue } from '../../src/send-queue'
import { OutboundQueue } from '../../src/outbound-queue'
import type { TrueConfChannelConfig, TrueConfResponse } from '../../src/types'

// OpenClaw 2026.9.9+ stages native modules so that sharp cannot find
// libvips-cpp.so. Loading outbound must not depend on sharp: the image goes
// out without a preview instead of the whole plugin failing to load.
vi.mock('sharp', () => {
  throw new Error('libvips-cpp.so.8.17.3: cannot open shared object file')
})

vi.mock('../../src/load-media', () => ({
  loadOutboundMediaFromUrl: vi.fn(),
}))

import { loadOutboundMediaFromUrl } from '../../src/load-media'
import { handleOutboundAttachmentToChat } from '../../src/outbound'

function ok(messageId: string): TrueConfResponse {
  return { type: 2, id: 1, payload: { errorCode: 0, messageId } }
}

describe('outbound without a loadable sharp', () => {
  it('sends an image without a preview and logs the fallback', async () => {
    vi.mocked(loadOutboundMediaFromUrl).mockResolvedValue({
      buffer: Buffer.alloc(50),
      contentType: 'image/png',
      kind: 'image',
      fileName: 'pic.png',
    } as never)

    const client = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'uploadFile') {
          return { type: 2, id: 1, payload: { errorCode: 0, uploadTaskId: 'task-1' } }
        }
        return ok(method === 'sendFile' ? 'm-file' : 'm-x')
      }),
      onAuth: () => () => {},
    }
    const warn = vi.fn()
    const logger = { info: () => {}, warn, error: () => {} }

    const uploads: FormData[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      uploads.push(init?.body as FormData)
      return new Response(JSON.stringify({ temporalFileId: 'tf-abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    try {
      const result = await handleOutboundAttachmentToChat(
        { chatId: 'chat-X', text: '', mediaUrl: 'file:///tmp/pic.png' },
        {
          outboundQueue: new OutboundQueue(client, logger),
          resolved: { serverUrl: 'tc.example.com', useTls: true, port: 443 },
          channelConfig: { serverUrl: 'tc.example.com', username: 'bot', password: 'pw', useTls: true } as TrueConfChannelConfig,
          logger,
          limits: new FileUploadLimits(50 * 1024 * 1024),
          sendQueue: new PerChatSendQueue(),
        },
      )
      expect(result).toEqual({ ok: true, messageId: 'm-file', chatId: 'chat-X' })
      expect(uploads).toHaveLength(1)
      expect(uploads[0].has('file')).toBe(true)
      expect(uploads[0].has('preview')).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('preview generation failed'))
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
