// Boots the in-process fake-server inside a container and exposes a small
// HTTP control plane for the e2e driver. The driver hits /control/dropAll
// to terminate the open WS (server keeps listening for the reconnect) --
// this is what the plugin's onDisconnected callback needs to fire so the
// in-flight batch2 items hit the WS-not-connected throw path and park.
// Docker-network disconnects don't sever already-open TCP cleanly enough:
// the kernel's retransmit can carry the writes past a partition window
// without the WS layer ever noticing.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { startFakeServer, type FakeServer } from '../smoke/fake-server'

const FAKE_PORT = Number(process.env.FAKE_PORT ?? 4309)
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 4310)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  const server: FakeServer = await startFakeServer({ host: HOST, port: FAKE_PORT })

  const control = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? ''
    if (req.method === 'POST' && url === '/control/dropAll') {
      server.dropAll()
      respondJson(res, 200, { dropped: true })
      return
    }
    if (req.method === 'GET' && url === '/control/state') {
      respondJson(res, 200, {
        authRequests: server.authRequests.length,
        messageRequests: server.messageRequests.length,
        connections: server.connections.size,
      })
      return
    }
    if (req.method === 'GET' && url === '/control/health') {
      respondJson(res, 200, { ok: true })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => control.listen(CONTROL_PORT, HOST, resolve))

  process.stdout.write(JSON.stringify({
    event: 'fake_server_ready',
    host: HOST,
    fakePort: server.port,
    controlPort: CONTROL_PORT,
  }) + '\n')

  const shutdown = async (signal: string) => {
    process.stdout.write(JSON.stringify({ event: 'fake_server_shutdown', signal }) + '\n')
    await server.close()
    await new Promise<void>((resolve) => control.close(() => resolve()))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

main().catch((err) => {
  process.stderr.write(`fake-server-bin error: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
