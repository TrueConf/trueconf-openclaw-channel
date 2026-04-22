// Pure probing/validation library: TrueConf reachability, TLS cert inspection,
// CA chain download, OAuth credential validation. All functions take
// parameters explicitly — no env reads, no stdio, no process.exit.

import { connect as tlsConnect } from 'node:tls'
import { createConnection as netConnect, isIP } from 'node:net'
import { writeFileSync, mkdirSync, chmodSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Agent as UndiciAgent } from 'undici'

const BRIDGE_PORT = 4309
const BRIDGE_TIMEOUT_MS = 3000
const TLS_TIMEOUT_MS = 4000
// AbortSignal.timeout is wall-clock, not socket-idle — on slow/corporate
// networks DNS+TLS handshake can eat 5+ seconds before the OAuth request
// body is even sent. Pick a value that survives that headroom.
const OAUTH_TIMEOUT_MS = 30000
const CA_FILE = join(homedir(), '.openclaw', 'trueconf-ca.pem')

async function probeBridge(host, port) {
  return new Promise((resolve) => {
    let done = false
    const finish = (open, error = null) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ open, error })
    }
    const socket = netConnect({ host, port, timeout: BRIDGE_TIMEOUT_MS })
    socket.on('connect', () => finish(true))
    socket.on('error', (err) => finish(false, err.code || err.message))
    socket.on('timeout', () => finish(false, 'TIMEOUT'))
  })
}

async function probeTlsRaw(host, port) {
  return new Promise((resolve) => {
    let done = false
    // `servername` (SNI) must be a hostname, not an IP. When the host is an IP
    // (common in local dev / probe tests), omit `servername` to avoid a
    // synchronous ERR_INVALID_ARG_VALUE from tlsConnect.
    const isIpHost = isIP(host) !== 0
    const connectOpts = {
      host,
      port,
      rejectUnauthorized: false,
      timeout: TLS_TIMEOUT_MS,
    }
    if (!isIpHost) connectOpts.servername = host
    let socket
    try {
      socket = tlsConnect(connectOpts, () => {
        if (done) return
        done = true
        const rawCert = socket.getPeerCertificate(true)
        const trusted = socket.authorized === true
        const authzErr = socket.authorizationError
        try { socket.end() } catch { /* ignore */ }
        resolve({
          reachable: true,
          trusted,
          authorizationError: authzErr ? String(authzErr) : null,
          cert: summarizeCert(rawCert),
          _rawCert: rawCert,
        })
      })
    } catch (err) {
      resolve({ reachable: false, error: err.code || err.message || 'unknown' })
      return
    }
    socket.on('error', (err) => {
      if (done) return
      done = true
      resolve({ reachable: false, error: err.code || err.message || 'unknown' })
    })
    socket.on('timeout', () => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ reachable: false, error: 'TIMEOUT' })
    })
  })
}

export async function probeTls({ host, port }) {
  // Default port order: try wss/443 first, then ws/4309, then http/80.
  const candidates = port !== undefined
    ? [{ port, useTls: port === 443 }]
    : [{ port: 443, useTls: true }, { port: 4309, useTls: false }, { port: 80, useTls: false }]

  for (const candidate of candidates) {
    if (candidate.useTls) {
      const tls = await probeTlsRaw(host, candidate.port)
      if (tls.reachable) {
        return {
          reachable: true,
          useTls: true,
          port: candidate.port,
          caUntrusted: !tls.trusted,
          caChain: tls._rawCert ? buildCertChainArray(tls._rawCert) : undefined,
          error: tls.authorizationError ?? undefined,
        }
      }
    } else {
      const bridge = await probeBridge(host, candidate.port)
      if (bridge.open) {
        return {
          reachable: true,
          useTls: false,
          port: candidate.port,
          caUntrusted: false,
        }
      }
    }
  }
  return {
    reachable: false,
    useTls: false,
    port: port ?? 0,
    caUntrusted: false,
    error: 'No TrueConf endpoint reachable on 443/4309/80',
  }
}

// Helper — reuse existing `buildCertChainPem` logic but return array.
function buildCertChainArray(rawCert) {
  const pem = buildCertChainPem(rawCert)
  return pem.split(/-----END CERTIFICATE-----\n?/).filter(Boolean).map(p => p + '-----END CERTIFICATE-----\n')
}

export async function downloadCAChain({ host, port }) {
  const tls = await probeTlsRaw(host, port)
  if (!tls.reachable) {
    throw new Error(`TLS probe unreachable: ${tls.error ?? 'unknown'}`)
  }
  if (!tls._rawCert) {
    throw new Error('No certificate chain available')
  }
  const pem = buildCertChainPem(tls._rawCert)
  mkdirSync(join(homedir(), '.openclaw'), { recursive: true })
  const tmp = `${CA_FILE}.tmp`
  writeFileSync(tmp, pem, 'utf8')
  try { chmodSync(tmp, 0o600) } catch { /* non-unix */ }
  renameSync(tmp, CA_FILE)
  return CA_FILE
}

export async function validateOAuthCredentials({
  serverUrl, username, password, useTls, port, caPath,
}) {
  const scheme = useTls ? 'https' : 'http'
  const hostport = port !== undefined ? `${serverUrl}:${port}` : serverUrl
  const url = `${scheme}://${hostport}/bridge/api/client/v1/oauth/token`

  // Node's global fetch is undici-backed; its `dispatcher` option requires an
  // undici Dispatcher, not a `node:https` Agent. Build an undici Agent that
  // trusts our downloaded CA chain when operating over TLS with a caPath.
  const dispatcher = caPath && useTls
    ? new UndiciAgent({ connect: { ca: readFileSync(caPath) } })
    : undefined

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'chat_bot',
        client_secret: '',
        grant_type: 'password',
        username,
        password,
      }),
      ...(dispatcher && { dispatcher }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    })
  } catch (err) {
    // `fetch failed` from undici is a generic wrapper; the real reason (DNS,
    // ECONNREFUSED, self-signed cert, etc.) lives in err.cause. Unwrap one
    // level so diagnostics aren't a black box.
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : null
    const causeCode = err instanceof Error && err.cause && typeof err.cause === 'object' && 'code' in err.cause
      ? String(err.cause.code)
      : null
    const outerMsg = err instanceof Error ? err.message : String(err)
    const msg = causeMsg ? `${outerMsg} (${causeCode ? `${causeCode}: ` : ''}${causeMsg})` : outerMsg

    // Covers the common OpenSSL error codes Node surfaces for cert problems:
    // SELF_SIGNED_CERT_IN_CHAIN, DEPTH_ZERO_SELF_SIGNED_CERT,
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE, UNABLE_TO_GET_ISSUER_CERT_LOCALLY,
    // CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID, plus general
    // "certificate"/"TLS" wording in the outer message.
    const tlsCodePattern = /^(SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_|ERR_TLS_)/
    if (msg.includes('certificate') || msg.includes('TLS') || (causeCode && tlsCodePattern.test(causeCode))) {
      return { ok: false, category: 'tls', error: msg }
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || outerMsg.includes('aborted due to timeout'))) {
      return {
        ok: false,
        category: 'network',
        error: `OAuth request did not complete within ${OAUTH_TIMEOUT_MS / 1000}s (server: ${hostport})`,
      }
    }
    return { ok: false, category: 'network', error: msg }
  }

  if (response.ok) return { ok: true }
  if (response.status === 401) {
    return { ok: false, category: 'invalid-credentials', error: '401 Unauthorized' }
  }
  if (response.status === 404) {
    return { ok: false, category: 'token-endpoint-missing', error: `${response.status} ${response.statusText}` }
  }
  if (response.status >= 500 && response.status < 600) {
    return { ok: false, category: 'server-error', error: `${response.status} ${response.statusText}` }
  }
  return { ok: false, category: 'unknown', error: `${response.status} ${response.statusText}` }
}

export function summarizeCert(cert) {
  if (!cert || typeof cert !== 'object' || Object.keys(cert).length === 0) return null
  const subjectCN = cert.subject?.CN || null
  const issuerCN = cert.issuer?.CN || null
  const issuerOrg = cert.issuer?.O || null
  const subjectOrg = cert.subject?.O || null
  return {
    subject: subjectCN,
    issuerOrg,
    issuerCN,
    validFrom: cert.valid_from || null,
    validTo: cert.valid_to || null,
    fingerprint: cert.fingerprint256 || cert.fingerprint || null,
    san: cert.subjectaltname || null,
    selfSigned: Boolean(subjectCN && issuerCN && subjectCN === issuerCN && (!issuerOrg || issuerOrg === subjectOrg)),
  }
}

export function decide({ host, bridge, tls, tlsOverride, portOverride }) {
  let useTls
  let port
  let reason

  if (tlsOverride === 'true') {
    useTls = true
    port = Number.isFinite(portOverride) ? portOverride : 443
    reason = 'override'
  } else if (tlsOverride === 'false') {
    useTls = false
    port = Number.isFinite(portOverride) ? portOverride : BRIDGE_PORT
    reason = 'override'
  } else if (tls?.reachable) {
    useTls = true
    port = 443
    reason = tls.trusted ? 'tls-valid' : 'tls-untrusted'
  } else if (bridge?.open) {
    useTls = false
    port = BRIDGE_PORT
    reason = 'bridge-open'
  } else {
    useTls = true
    port = 443
    reason = 'nothing-reachable'
  }

  const isDefaultPort = (useTls && port === 443) || (!useTls && port === 80)
  const hostPart = isDefaultPort ? host : `${host}:${port}`
  const wsProtocol = useTls ? 'wss' : 'ws'
  const httpProtocol = useTls ? 'https' : 'http'

  return {
    useTls,
    port,
    reason,
    protocol: wsProtocol,
    wsUrl: `${wsProtocol}://${hostPart}/websocket/chat_bot/`,
    tokenUrl: `${httpProtocol}://${hostPart}/bridge/api/client/v1/oauth/token`,
    explicitPort: reason === 'override' && Number.isFinite(portOverride),
  }
}

function derToPem(derBuffer) {
  const base64 = derBuffer.toString('base64')
  const lines = base64.match(/.{1,64}/g) || []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

export function buildCertChainPem(leafCert) {
  if (!leafCert || !leafCert.raw) return ''
  const pems = []
  const seen = new Set()
  let current = leafCert
  while (current && current.raw) {
    const fp = current.fingerprint256 || current.fingerprint
    if (fp && seen.has(fp)) break
    if (fp) seen.add(fp)
    pems.push(derToPem(current.raw))
    if (current.issuerCertificate && current.issuerCertificate !== current) {
      current = current.issuerCertificate
    } else {
      break
    }
  }
  return pems.join('\n')
}

export function categorizeOAuthError(status) {
  if (status === 401 || status === 403) return 'invalid-credentials'
  if (status === 404) return 'endpoint-missing'
  if (status === 0) return 'network'
  if (status >= 500) return 'server-error'
  if (status >= 200 && status < 300) return 'ok'
  return 'other'
}
