import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn().mockResolvedValue({}),
}))

import { __resetForTesting, channelPlugin, registerFull } from '../../src/channel'
import { startFakeServer, waitFor, type FakeServer } from '../smoke/fake-server'

interface Harness {
  abort: () => void
  startPromise: Promise<void>
}

async function bootPlugin(server: FakeServer): Promise<Harness> {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const api = {
    logger,
    runtime: {},
    config: {
      channels: {
        trueconf: {
          serverUrl: server.serverUrl,
          port: server.port,
          useTls: false,
          username: 'bot@srv',
          password: 'secret',
          dmPolicy: 'open',
        },
      },
    },
    on: () => {},
  }
  registerFull(api as never)
  const ac = new AbortController()
  const startPromise = (channelPlugin.gateway.startAccount as (ctx: Record<string, unknown>) => Promise<void>)({
    accountId: 'default',
    setStatus: () => {},
    abortSignal: ac.signal,
  })
  await waitFor(() => server.authRequests.length >= 1 && server.connections.size > 0)
  return { abort: () => ac.abort(), startPromise }
}

type SendMedia = (ctx: Record<string, unknown>) => Promise<{ channel: string; messageId: string }>

describe('integration: outbound attachment (sendMedia)', () => {
  let server: FakeServer
  let harness: Harness | null = null
  let workDir: string

  beforeEach(async () => {
    __resetForTesting()
    server = await startFakeServer()
    workDir = await mkdtemp(join(tmpdir(), 'tc-out-'))
  })

  afterEach(async () => {
    if (harness) {
      harness.abort()
      await Promise.race([harness.startPromise.catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      harness = null
    }
    await server.close()
    await rm(workDir, { recursive: true, force: true })
  })

  it('uploads local file via WS uploadFile + HTTP POST + WS sendFile with caption', async () => {
    harness = await bootPlugin(server)

    const filePath = join(workDir, 'doc.bin')
    const bytes = Buffer.from('OUTBOUND-BYTES-FOR-UPLOAD', 'utf8')
    await writeFile(filePath, bytes)

    const sendMedia = (channelPlugin.outbound as { sendMedia: SendMedia }).sendMedia
    const result = await sendMedia({
      to: 'alice@srv',
      text: 'here is the picture',
      mediaUrl: pathToFileURL(filePath).toString(),
      mediaLocalRoots: [workDir],
      accountId: 'default',
    })

    expect(result.channel).toBe('trueconf')
    expect(result.messageId).toMatch(/^fmsg_/)

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)

    expect(server.uploadFileRequests).toHaveLength(1)
    expect(server.uploadFileRequests[0].payload.fileSize).toBe(bytes.length)
    // Server rejects uploadFile with errorCode=310 (FILE_UPLOAD_FAILED) when
    // fileName is missing: the docs declare fileSize AND fileName as required.
    expect(server.uploadFileRequests[0].payload.fileName).toBe('doc.bin')

    expect(server.httpUploads).toHaveLength(1)
    const upload = server.httpUploads[0]
    expect(upload.uploadTaskId).toMatch(/^task_/)
    expect(upload.contentType?.startsWith('multipart/form-data')).toBe(true)
    expect(upload.bytes.includes(bytes)).toBe(true)

    const sendFilePayload = server.sendFileRequests[0].payload as {
      chatId: string
      content: { temporalFileId: string; caption?: { text: string } }
    }
    expect(sendFilePayload.chatId).toBe('chat_alice@srv')
    expect(sendFilePayload.content.temporalFileId).toMatch(/^temp_/)
    expect(sendFilePayload.content.caption?.text).toBe('here is the picture')
  })

  it('sendMedia without caption omits the caption key in the sendFile payload', async () => {
    harness = await bootPlugin(server)

    const filePath = join(workDir, 'noc.bin')
    await writeFile(filePath, Buffer.from('PLAIN-BYTES'))

    const sendMedia = (channelPlugin.outbound as { sendMedia: SendMedia }).sendMedia
    await sendMedia({
      to: 'alice@srv',
      text: '',
      mediaUrl: pathToFileURL(filePath).toString(),
      mediaLocalRoots: [workDir],
      accountId: 'default',
    })

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)
    const payload = server.sendFileRequests[0].payload as {
      content?: { caption?: unknown }
    }
    expect(payload.content?.caption).toBeUndefined()
  })

  // TrueConf renders attachments inline (as photos) only when the multipart
  // upload also carries a `preview` WebP alongside the main `file` field;
  // otherwise the message renders as a downloadable document. For image MIMEs
  // we generate a small WebP preview via sharp and attach it to the multipart.
  it('sendMedia attaches a WebP preview in the multipart for image MIMEs', async () => {
    harness = await bootPlugin(server)

    const pngBytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer()
    const filePath = join(workDir, 'pic.png')
    await writeFile(filePath, pngBytes)

    const sendMedia = (channelPlugin.outbound as { sendMedia: SendMedia }).sendMedia
    await sendMedia({
      to: 'alice@srv',
      text: 'photo',
      mediaUrl: pathToFileURL(filePath).toString(),
      mediaLocalRoots: [workDir],
      accountId: 'default',
    })

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)
    expect(server.httpUploads).toHaveLength(1)
    const body = server.httpUploads[0].bytes.toString('binary')
    expect(body).toContain('name="preview"')
    expect(body).toContain('Content-Type: image/webp')
  })

  it('sendMedia omits the preview field for non-image MIMEs', async () => {
    harness = await bootPlugin(server)

    const filePath = join(workDir, 'doc.bin')
    await writeFile(filePath, Buffer.from('not-an-image'))

    const sendMedia = (channelPlugin.outbound as { sendMedia: SendMedia }).sendMedia
    await sendMedia({
      to: 'alice@srv',
      text: '',
      mediaUrl: pathToFileURL(filePath).toString(),
      mediaLocalRoots: [workDir],
      accountId: 'default',
    })

    await waitFor(() => server.sendFileRequests.length >= 1, 5000)
    const body = server.httpUploads[0].bytes.toString('binary')
    expect(body).not.toContain('name="preview"')
  })
})
