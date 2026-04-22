import { createServer } from 'node:tls'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURES = join(process.cwd(), 'tests', '__fixtures__')

// Start a local TLS server using the named fixture (without the -valid/-other
// suffix). Returns { port, close }.
export async function startTlsFixtureServer(name = 'ca-valid') {
  const cert = readFileSync(join(FIXTURES, `${name}.pem`))
  const key = readFileSync(join(FIXTURES, `${name}.key`))
  const server = createServer({ cert, key }, (socket) => socket.end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
