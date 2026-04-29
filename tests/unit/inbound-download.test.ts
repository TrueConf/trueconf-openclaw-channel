import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch, Agent as UndiciAgent } from 'undici'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadFile } from '../../src/inbound'
import type { Logger } from '../../src/types'

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, fetch: vi.fn(actual.fetch) }
})

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('downloadFile — TLS trust threading', () => {
  let server: Server
  let port: number
  let workDir: string
  let url: string
  const payload = Buffer.from('hello world payload')

  beforeEach(async () => {
    vi.mocked(undiciFetch).mockClear()
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
    url = `http://127.0.0.1:${port}/file.bin`
    workDir = await mkdtemp(join(tmpdir(), 'tc-dl-'))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(workDir, { recursive: true, force: true })
  })

  // The bug the reviewer caught: downloadFile used bare fetch() and ignored
  // the per-account undici dispatcher that OAuth + WS already use. On
  // caPath / tlsVerify:false deployments OAuth and WS connect, but inbound
  // media downloads fail. This test pins the contract — a dispatcher passed
  // to downloadFile is forwarded to the underlying fetch call.
  it('forwards the dispatcher to fetch when one is provided', async () => {
    const dispatcher = new UndiciAgent()
    try {
      const dest = join(workDir, 'out-with-dispatcher.bin')
      const result = await downloadFile(url, dest, 1024 * 1024, silentLogger, dispatcher)
      expect(result.ok).toBe(true)
      const written = await readFile(dest)
      expect(written.equals(payload)).toBe(true)

      const [, init] = vi.mocked(undiciFetch).mock.calls.at(-1)!
      expect(init).toBeDefined()
      expect((init as { dispatcher?: unknown }).dispatcher).toBe(dispatcher)
    } finally {
      await dispatcher.close()
    }
  })

  it('passes no init object when dispatcher is omitted (system trust path)', async () => {
    const dest = join(workDir, 'out-no-dispatcher.bin')
    const result = await downloadFile(url, dest, 1024 * 1024, silentLogger)
    expect(result.ok).toBe(true)

    const [, init] = vi.mocked(undiciFetch).mock.calls.at(-1)!
    expect(init).toBeUndefined()
  })
})
