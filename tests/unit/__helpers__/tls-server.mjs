import { createServer } from 'node:tls'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HELPER_DIR, '..', '..', '__fixtures__')

// Start a local TLS server using the named fixture (without the -valid/-other
// suffix). Returns { port, close }.
export async function startTlsFixtureServer(name = 'ca-valid') {
  const cert = readFileSync(join(FIXTURES, `${name}.pem`))
  const key = readFileSync(join(FIXTURES, `${name}.key`))
  const server = createServer({ cert, key }, (socket) => {
    // Swallow post-close EPIPE/ECONNRESET — Node would otherwise surface an
    // uncaught 'error' on the socket and crash the test process.
    socket.on('error', () => {})
    socket.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
