import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  summarizeCert,
  decide,
  categorizeOAuthError,
  buildCertChainPem,
  validateCaAgainstServer,
} from '../../src/probe.mjs'
import { startTlsFixtureServer } from './__helpers__/tls-server.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', '__fixtures__')

describe('probe-trueconf: summarizeCert', () => {
  it('returns null for empty object', () => {
    expect(summarizeCert({})).toBeNull()
    expect(summarizeCert(null)).toBeNull()
  })

  it('extracts issuer and subject CN/O', () => {
    const cert = {
      subject: { CN: 'team.trueconf.com', O: 'TrueConf' },
      issuer: { CN: 'R3', O: "Let's Encrypt" },
      valid_from: 'Jan 1 00:00:00 2026 GMT',
      valid_to: 'Apr 1 00:00:00 2026 GMT',
      fingerprint256: 'AA:BB:CC',
    }
    const s = summarizeCert(cert)
    expect(s).toEqual({
      subject: 'team.trueconf.com',
      issuerOrg: "Let's Encrypt",
      issuerCN: 'R3',
      validFrom: 'Jan 1 00:00:00 2026 GMT',
      validTo: 'Apr 1 00:00:00 2026 GMT',
      fingerprint: 'AA:BB:CC',
      san: null,
      selfSigned: false,
    })
  })

  it('flags self-signed when subject CN equals issuer CN and org matches', () => {
    const cert = {
      subject: { CN: 'trueconf.internal', O: 'Acme Corp' },
      issuer: { CN: 'trueconf.internal', O: 'Acme Corp' },
    }
    expect(summarizeCert(cert)?.selfSigned).toBe(true)
  })

  it('does not flag self-signed when issuer org differs from subject org', () => {
    const cert = {
      subject: { CN: 'trueconf.example', O: 'Example Inc' },
      issuer: { CN: 'trueconf.example', O: 'Corporate CA' },
    }
    expect(summarizeCert(cert)?.selfSigned).toBe(false)
  })
})

describe('probe-trueconf: decide', () => {
  const host = 'team.trueconf.com'

  it('picks tls-valid when TLS reachable and trusted', () => {
    const d = decide({ host, bridge: { open: true }, tls: { reachable: true, trusted: true } })
    expect(d).toMatchObject({
      useTls: true,
      port: 443,
      reason: 'tls-valid',
      wsUrl: 'wss://team.trueconf.com/websocket/chat_bot/',
      tokenUrl: 'https://team.trueconf.com/bridge/api/client/v1/oauth/token',
    })
  })

  it('picks tls-untrusted when TLS reachable but not trusted', () => {
    const d = decide({ host, bridge: { open: false }, tls: { reachable: true, trusted: false } })
    expect(d.reason).toBe('tls-untrusted')
    expect(d.useTls).toBe(true)
  })

  it('falls back to bridge-open when TLS unreachable but bridge open', () => {
    const d = decide({ host, bridge: { open: true }, tls: { reachable: false } })
    expect(d).toMatchObject({
      useTls: false,
      port: 4309,
      reason: 'bridge-open',
      wsUrl: 'ws://team.trueconf.com:4309/websocket/chat_bot/',
    })
  })

  it('falls back to nothing-reachable with TLS defaults', () => {
    const d = decide({ host, bridge: { open: false }, tls: { reachable: false } })
    expect(d.reason).toBe('nothing-reachable')
    expect(d.useTls).toBe(true)
    expect(d.port).toBe(443)
  })

  it('honors tlsOverride=true and custom port', () => {
    const d = decide({ host, bridge: null, tls: null, tlsOverride: 'true', portOverride: 8443 })
    expect(d).toMatchObject({
      useTls: true,
      port: 8443,
      reason: 'override',
      explicitPort: true,
      wsUrl: 'wss://team.trueconf.com:8443/websocket/chat_bot/',
    })
  })

  it('honors tlsOverride=false without port override -> defaults to 4309', () => {
    const d = decide({ host, bridge: null, tls: null, tlsOverride: 'false', portOverride: null })
    expect(d.useTls).toBe(false)
    expect(d.port).toBe(4309)
    expect(d.explicitPort).toBe(false)
  })

  it('omits port from URL when TLS and port=443 (scheme default)', () => {
    const d = decide({ host, tls: { reachable: true, trusted: true } })
    expect(d.wsUrl).toBe('wss://team.trueconf.com/websocket/chat_bot/')
    expect(d.tokenUrl).toBe('https://team.trueconf.com/bridge/api/client/v1/oauth/token')
  })
})

describe('probe-trueconf: categorizeOAuthError', () => {
  it('maps 401/403 to invalid-credentials', () => {
    expect(categorizeOAuthError(401)).toBe('invalid-credentials')
    expect(categorizeOAuthError(403)).toBe('invalid-credentials')
  })

  it('maps 404 to endpoint-missing', () => {
    expect(categorizeOAuthError(404)).toBe('endpoint-missing')
  })

  it('maps 0 to network', () => {
    expect(categorizeOAuthError(0)).toBe('network')
  })

  it('maps 5xx to server-error', () => {
    expect(categorizeOAuthError(500)).toBe('server-error')
    expect(categorizeOAuthError(503)).toBe('server-error')
  })

  it('maps 200-299 to ok', () => {
    expect(categorizeOAuthError(200)).toBe('ok')
    expect(categorizeOAuthError(299)).toBe('ok')
  })

  it('falls back to other for 300/400', () => {
    expect(categorizeOAuthError(301)).toBe('other')
    expect(categorizeOAuthError(418)).toBe('other')
  })
})

describe('probe-trueconf: buildCertChainPem', () => {
  it('returns empty string for null cert', () => {
    expect(buildCertChainPem(null)).toBe('')
    expect(buildCertChainPem({})).toBe('')
  })

  it('encodes a single cert as PEM', () => {
    const leaf = {
      raw: Buffer.from('hello'),
      fingerprint256: 'AA',
    }
    const pem = buildCertChainPem(leaf)
    expect(pem).toContain('-----BEGIN CERTIFICATE-----')
    expect(pem).toContain('-----END CERTIFICATE-----')
    expect(pem).toContain(Buffer.from('hello').toString('base64'))
  })

  it('walks issuer chain', () => {
    const root = { raw: Buffer.from('root-cert'), fingerprint256: 'ROOT' }
    root.issuerCertificate = root
    const intermediate = { raw: Buffer.from('inter-cert'), fingerprint256: 'INT', issuerCertificate: root }
    const leaf = { raw: Buffer.from('leaf-cert'), fingerprint256: 'LEAF', issuerCertificate: intermediate }
    const pem = buildCertChainPem(leaf)
    const count = pem.match(/BEGIN CERTIFICATE/g)?.length ?? 0
    expect(count).toBe(3)
  })

  it('does not loop on self-referencing root', () => {
    const root = { raw: Buffer.from('self'), fingerprint256: 'SELF' }
    root.issuerCertificate = root
    const pem = buildCertChainPem(root)
    const count = pem.match(/BEGIN CERTIFICATE/g)?.length ?? 0
    expect(count).toBe(1)
  })
})

import { probeTls } from '../../src/probe.mjs'

describe('probeTls', () => {
  it('is exported and returns an object with reachable/useTls/port/caUntrusted', async () => {
    // Point at loopback with a port that definitely isn't listening.
    const result = await probeTls({ host: '127.0.0.1', port: 1 })
    expect(result).toMatchObject({
      reachable: expect.any(Boolean),
      useTls: expect.any(Boolean),
      port: expect.any(Number),
      caUntrusted: expect.any(Boolean),
    })
    expect(result.reachable).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

import { createServer } from 'node:net'

describe('probeTls reachability', () => {
  it('returns reachable=true for open plain-TCP port (bridge path)', async () => {
    const server = createServer().listen(0)
    await new Promise(r => server.once('listening', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const result = await probeTls({ host: '127.0.0.1', port })
    server.close()

    expect(result.reachable).toBe(true)
    expect(result.port).toBe(port)
    expect(result.useTls).toBe(false)
  })
})

describe('probeTls({ca}) strict mode', () => {
  it('returns caUntrusted=false when ca matches server cert', async () => {
    const server = await startTlsFixtureServer('ca-valid')
    const ca = readFileSync(join(FIXTURES, 'ca-valid.pem'))
    try {
      const r = await probeTls({ host: '127.0.0.1', port: server.port, ca })
      expect(r.reachable).toBe(true)
      expect(r.caUntrusted).toBe(false)
      expect(r.cert).toBeTruthy()
      expect(r.cert.subject).toBe('localhost')
    } finally {
      await server.close()
    }
  })

  it('returns caUntrusted=true with a different CA (no handshake abort)', async () => {
    const server = await startTlsFixtureServer('ca-valid')
    const wrongCa = readFileSync(join(FIXTURES, 'ca-other.pem'))
    try {
      const r = await probeTls({ host: '127.0.0.1', port: server.port, ca: wrongCa })
      expect(r.reachable).toBe(true)
      expect(r.caUntrusted).toBe(true)
      expect(r.cert).toBeTruthy()
      expect(r.error).toBeTruthy()
    } finally {
      await server.close()
    }
  })

  it('still returns cert in the legacy (no ca) path', async () => {
    const server = await startTlsFixtureServer('ca-valid')
    try {
      const r = await probeTls({ host: '127.0.0.1', port: server.port })
      expect(r.reachable).toBe(true)
      expect(r.useTls).toBe(true)
      expect(r.cert).toBeTruthy()
      expect(r.cert.subject).toBe('localhost')
    } finally {
      await server.close()
    }
  })
})

describe('validateCaAgainstServer', () => {
  it('returns ok=true when caBytes matches the server cert', async () => {
    const server = await startTlsFixtureServer('ca-valid')
    const ca = readFileSync(join(FIXTURES, 'ca-valid.pem'))
    try {
      const r = await validateCaAgainstServer({ caBytes: ca, host: '127.0.0.1', port: server.port })
      expect(r.ok).toBe(true)
      expect(r.error).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('returns ok=false with serverCert populated when caBytes is wrong', async () => {
    const server = await startTlsFixtureServer('ca-valid')
    const wrongCa = readFileSync(join(FIXTURES, 'ca-other.pem'))
    try {
      const r = await validateCaAgainstServer({ caBytes: wrongCa, host: '127.0.0.1', port: server.port })
      expect(r.ok).toBe(false)
      expect(r.serverCert).toBeTruthy()
      expect(r.serverCert.subject).toBe('localhost')
      expect(r.error).toBeTruthy()
    } finally {
      await server.close()
    }
  })

  it('returns ok=false with error when server is unreachable', async () => {
    const ca = readFileSync(join(FIXTURES, 'ca-valid.pem'))
    const r = await validateCaAgainstServer({ caBytes: ca, host: '127.0.0.1', port: 1 })
    expect(r.ok).toBe(false)
    expect(r.serverCert).toBeUndefined()
    expect(r.error).toBeTruthy()
  })
})

import { downloadCAChain } from '../../src/probe.mjs'

describe('downloadCAChain', () => {
  it('throws for unreachable host', async () => {
    await expect(downloadCAChain({ host: '127.0.0.1', port: 1 }))
      .rejects.toThrow(/unreachable|ECONNREFUSED/i)
  })

  // Integration test against real TLS server done in setup-wizard.test.ts.
})

import { validateOAuthCredentials } from '../../src/probe.mjs'

describe('validateOAuthCredentials', () => {
  it('returns {ok:false, category:"network"} for unreachable host', async () => {
    const result = await validateOAuthCredentials({
      serverUrl: '127.0.0.1',
      username: 'bot@localhost',
      password: 'secret',
      useTls: false,
      port: 1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.category).toBe('network')
      expect(result.error).toBeTruthy()
    }
  })
})

import { vi } from 'vitest'

describe('validateOAuthCredentials — status codes', () => {
  it('returns invalid-credentials on 401', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }))
    try {
      const result = await validateOAuthCredentials({
        serverUrl: 'tc.example.com', username: 'bot', password: 'wrong', useTls: true, port: 443,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.category).toBe('invalid-credentials')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('returns token-endpoint-missing on 404', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('Not Found', { status: 404, statusText: 'Not Found' }))
    try {
      const result = await validateOAuthCredentials({
        serverUrl: 'tc.example.com', username: 'bot', password: 'secret', useTls: true, port: 443,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.category).toBe('token-endpoint-missing')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('returns ok on 200', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('{"access_token":"xyz"}', { status: 200 }))
    try {
      const result = await validateOAuthCredentials({
        serverUrl: 'tc.example.com', username: 'bot', password: 'ok', useTls: true, port: 443,
      })
      expect(result.ok).toBe(true)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('returns server-error on 500', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }))
    try {
      const result = await validateOAuthCredentials({
        serverUrl: 'tc.example.com', username: 'bot', password: 'ok', useTls: true, port: 443,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.category).toBe('server-error')
        expect(result.error).toContain('500')
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('passes through undici dispatcher when ca+useTls is set (401 path)', async () => {
    // Lock in C1: the implementation must use an undici Agent (valid Dispatcher),
    // not a node:https Agent. If the wrong Agent is passed as `dispatcher`, fetch
    // throws `TypeError: agent.dispatch is not a function` which bubbles up as
    // category 'network' -- NOT the 401-based 'invalid-credentials' we expect.
    // A well-formed (but fake) PEM — undici Agent accepts the bytes at construction,
    // and since fetch is mocked the cert is never actually used.
    const ca = Buffer.from('-----BEGIN CERTIFICATE-----\nMIIBAA==\n-----END CERTIFICATE-----\n', 'utf8')

    const origFetch = globalThis.fetch
    let seenDispatcher
    globalThis.fetch = vi.fn(async (_url, init) => {
      seenDispatcher = init?.dispatcher
      return new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    })
    try {
      const result = await validateOAuthCredentials({
        serverUrl: 'tc.example.com',
        username: 'bot',
        password: 'wrong',
        useTls: true,
        port: 443,
        ca,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.category).toBe('invalid-credentials')
      // Must be a real undici Dispatcher (has .dispatch function), not node:https.Agent.
      expect(seenDispatcher).toBeDefined()
      expect(typeof seenDispatcher.dispatch).toBe('function')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

import { parseDn } from '../../src/probe.mjs'

describe('parseDn', () => {
  it('returns null/null for empty or null input', () => {
    expect(parseDn('')).toEqual({ cn: null, o: null })
    expect(parseDn(null)).toEqual({ cn: null, o: null })
    expect(parseDn(undefined)).toEqual({ cn: null, o: null })
  })

  it('parses CN only', () => {
    expect(parseDn('CN=foo')).toEqual({ cn: 'foo', o: null })
  })

  it('parses newline-separated CN and O', () => {
    expect(parseDn('CN=foo\nO=Bar')).toEqual({ cn: 'foo', o: 'Bar' })
  })

  it('parses comma-separated RFC 4514 style', () => {
    expect(parseDn('CN=foo, O=Bar, C=US')).toEqual({ cn: 'foo', o: 'Bar' })
  })

  it('parses quoted values with internal commas', () => {
    expect(parseDn('O="Acme, Inc."\nCN=tc.example.com'))
      .toEqual({ cn: 'tc.example.com', o: 'Acme, Inc.' })
  })

  it('parses backslash-escaped commas', () => {
    expect(parseDn('O=Acme\\, Inc.\nCN=foo'))
      .toEqual({ cn: 'foo', o: 'Acme, Inc.' })
  })

  it('preserves unicode in CN and O', () => {
    expect(parseDn('CN=Фирма\nO=ООО «Ромашка»'))
      .toEqual({ cn: 'Фирма', o: 'ООО «Ромашка»' })
  })
})

import { parseCertFromPem } from '../../src/probe.mjs'

describe('parseCertFromPem', () => {
  it('returns CertSummary for valid self-signed PEM', () => {
    const bytes = readFileSync(join(FIXTURES, 'ca-valid.pem'))
    const cert = parseCertFromPem(bytes)
    expect(cert).not.toBeNull()
    expect(cert.subject).toBe('localhost')
    expect(cert.issuerCN).toBe('localhost')
    expect(cert.issuerOrg).toBe('Acme, Inc.')
    expect(cert.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(cert.selfSigned).toBe(true)
    expect(cert.validFrom).toBeTruthy()
    expect(cert.validTo).toBeTruthy()
  })

  it('correctly extracts O with comma in value', () => {
    const bytes = readFileSync(join(FIXTURES, 'ca-valid.pem'))
    const cert = parseCertFromPem(bytes)
    expect(cert.issuerOrg).toBe('Acme, Inc.')
  })

  it('returns CertSummary for expired cert without throwing', () => {
    const bytes = readFileSync(join(FIXTURES, 'ca-expired.pem'))
    const cert = parseCertFromPem(bytes)
    expect(cert).not.toBeNull()
    expect(cert.subject).toBe('expired.example')
    expect(cert.validTo).toMatch(/2020/)
  })

  it('extracts SAN when present', () => {
    const bytes = readFileSync(join(FIXTURES, 'ca-valid.pem'))
    const cert = parseCertFromPem(bytes)
    expect(cert.san).toMatch(/localhost/)
  })

  it('parses only the first cert in a multi-cert bundle', () => {
    const bytes = readFileSync(join(FIXTURES, 'chain-bundle.pem'))
    const cert = parseCertFromPem(bytes)
    expect(cert).not.toBeNull()
    // chain-bundle.pem starts with ca-valid; Acme is its O
    expect(cert.issuerOrg).toBe('Acme, Inc.')
  })

  it('returns null for non-PEM bytes', () => {
    expect(parseCertFromPem(Buffer.from('not a cert'))).toBeNull()
  })

  it('returns null for empty buffer', () => {
    expect(parseCertFromPem(Buffer.alloc(0))).toBeNull()
  })

  it('returns null for truncated PEM', () => {
    const bytes = Buffer.from('-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n')
    expect(parseCertFromPem(bytes)).toBeNull()
  })
})
