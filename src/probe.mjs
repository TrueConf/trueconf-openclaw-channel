// Pure probing/validation library: TrueConf reachability, TLS cert inspection,
// CA chain download, OAuth credential validation. All functions take
// parameters explicitly — no env reads, no stdio, no process.exit.

import { connect as tlsConnect } from 'node:tls'
import { createConnection as netConnect, isIP } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { Agent as UndiciAgent, fetch } from 'undici'

const BRIDGE_PORT = 4309
const BRIDGE_TIMEOUT_MS = 3000
const TLS_TIMEOUT_MS = 4000
// AbortSignal.timeout is wall-clock, not socket-idle — on slow/corporate
// networks DNS+TLS handshake can eat 5+ seconds before the OAuth request
// body is even sent. Pick a value that survives that headroom.
const OAUTH_TIMEOUT_MS = 30000
const CA_FILE = join(homedir(), '.openclaw', 'trueconf-ca.pem')

// describeErr captures `code` when Node sets one (ECONNREFUSED, ENOTFOUND),
// otherwise falls back to the message, finally to String(err). Never returns
// the literal 'unknown' sentinel — operators lose all diagnostic ground when
// an error code degrades to a generic word.
function describeErr(err) {
  if (!err) return 'unknown-null-error'
  const code = err.code ? String(err.code) : null
  const msg = err.message ? String(err.message) : null
  return code || msg || String(err)
}

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
    socket.on('error', (err) => finish(false, describeErr(err)))
    socket.on('timeout', () => finish(false, 'TIMEOUT'))
  })
}

async function probeTlsRaw(host, port, ca) {
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
    if (ca) connectOpts.ca = ca
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
      resolve({ reachable: false, error: describeErr(err) })
      return
    }
    socket.on('error', (err) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ reachable: false, error: describeErr(err) })
    })
    socket.on('timeout', () => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ reachable: false, error: 'TIMEOUT' })
    })
  })
}

export async function probeTls({ host, port, ca }) {
  // Candidate selection:
  //  - explicit port + `ca`: single TLS attempt so strict validation runs against
  //    the bytes the caller supplied. Without this, port: 8443 + ca: <bytes>
  //    silently went through probeBridge and never validated.
  //  - explicit port 443: single TLS attempt (scheme-default, bridge on 443 is
  //    never the configuration we want to fall through to).
  //  - other explicit port: TLS first, then bridge, so a cert is surfaced for
  //    diagnostic/banner use whenever the port speaks TLS at all.
  //  - no port: try 443 TLS, then 4309 bridge, then 80 bridge.
  const candidates = port !== undefined
    ? (ca !== undefined || port === 443
        ? [{ port, useTls: true }]
        : [{ port, useTls: true }, { port, useTls: false }])
    : [{ port: 443, useTls: true }, { port: 4309, useTls: false }, { port: 80, useTls: false }]

  for (const candidate of candidates) {
    if (candidate.useTls) {
      const tls = await probeTlsRaw(host, candidate.port, ca)
      if (tls.reachable) {
        return {
          reachable: true,
          useTls: true,
          port: candidate.port,
          caUntrusted: !tls.trusted,
          cert: tls.cert ?? undefined,
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
    error: port !== undefined
      ? `No TrueConf endpoint reachable on ${host}:${port}`
      : 'No TrueConf endpoint reachable on 443/4309/80',
  }
}

export async function downloadCAChain({ host, port, caFilePath = CA_FILE }) {
  const tls = await probeTlsRaw(host, port)
  if (!tls.reachable) {
    throw new Error(`TLS probe unreachable: ${tls.error ?? 'unknown'}`)
  }
  if (!tls._rawCert) {
    throw new Error('No certificate chain available')
  }
  const pem = buildCertChainPem(tls._rawCert)
  mkdirSync(dirname(caFilePath), { recursive: true })
  const tmp = `${caFilePath}.tmp`
  writeFileSync(tmp, pem, 'utf8')
  try {
    chmodSync(tmp, 0o600)
  } catch (err) {
    // ENOSYS: exotic fs that doesn't implement chmod (never normal Windows —
    // Windows maps chmod to a partial no-op and does not throw). EPERM/EACCES
    // on a file we just wrote means something is genuinely off (privileged
    // parent dir, foreign-owned ~/.openclaw); surfacing beats silently
    // leaving a umask-default trust anchor on disk.
    if (err.code !== 'ENOSYS') throw err
  }
  renameSync(tmp, caFilePath)
  // Return the just-written PEM alongside the path so callers can feed the
  // bytes to a validator without re-reading from disk — closes a narrow
  // TOCTOU window where the file could be swapped between write and re-read.
  return { path: caFilePath, bytes: Buffer.from(pem, 'utf8') }
}

export async function validateOAuthCredentials({
  serverUrl, username, password, useTls, port, ca, tlsVerify,
}) {
  // Guard against silent CA-drop: caller passed CA bytes but flipped useTls
  // off (or left it undefined). The old code would hand the CA to nothing
  // and ship the OAuth call over http:// with no TLS at all. Fail loud so
  // the contract "ca without useTls=true is meaningless" is visible.
  if (ca !== undefined && useTls !== true) {
    throw new Error(
      'validateOAuthCredentials: `ca` provided but `useTls` is not true — ' +
      'the CA would be silently ignored. Pass useTls:true alongside ca, or ' +
      'omit ca when connecting over plain HTTP.',
    )
  }
  // Same shape, different flag: tlsVerify:false on a plain-HTTP call is a
  // contradiction (nothing to verify), and the wizard would silently send
  // creds over http://. Fail loud.
  if (tlsVerify === false && useTls !== true) {
    throw new Error(
      'validateOAuthCredentials: `tlsVerify:false` requires `useTls:true` — ' +
      'TLS verification cannot be disabled on a plain-HTTP request.',
    )
  }

  const scheme = useTls ? 'https' : 'http'
  const hostport = port !== undefined ? `${serverUrl}:${port}` : serverUrl
  const url = `${scheme}://${hostport}/bridge/api/client/v1/oauth/token`

  // Node's global fetch is undici-backed; its `dispatcher` option requires an
  // undici Dispatcher, not a `node:https` Agent. Build an undici Agent that
  // trusts the caller-supplied CA bytes (or skips verification for the
  // operator-acknowledged insecure mode) when operating over TLS.
  //
  // We always own a Dispatcher here — even when no TLS overrides are needed —
  // so the function can drain its keep-alive pool in finally. Without that,
  // libuv on Windows asserts !(handle->flags & UV_HANDLE_CLOSING) at
  // src/win/async.c when the wizard's CLI exits right after this call returns
  // (Node bug nodejs/node#56645, unfixed through 24.13.1).
  const connect = {}
  if (ca && useTls) connect.ca = ca
  if (tlsVerify === false && useTls) connect.rejectUnauthorized = false
  const dispatcher = new UndiciAgent({ connect })

  try {
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
        dispatcher,
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
  } finally {
    // Best-effort: a dispatcher cleanup error must not mask the OAuth result.
    try { await dispatcher.close() } catch { /* ignore */ }
  }
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

// Split a DN string on unescaped commas and newlines, honoring quoted sections.
function splitDn(dn) {
  const parts = []
  let current = ''
  let inQuote = false
  let i = 0
  while (i < dn.length) {
    const c = dn[i]
    if (c === '\\' && i + 1 < dn.length) {
      current += dn[i] + dn[i + 1]
      i += 2
      continue
    }
    if (c === '"') {
      inQuote = !inQuote
      current += c
      i += 1
      continue
    }
    if (!inQuote && (c === '\n' || c === ',')) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      i += 1
      continue
    }
    current += c
    i += 1
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function extractRdn(dn, key) {
  const parts = splitDn(dn)
  for (const part of parts) {
    if (!part.startsWith(`${key}=`)) continue
    let raw = part.slice(key.length + 1)
    if (raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1)
    }
    const unescaped = raw.replace(/\\(.)/g, '$1').trim()
    return unescaped || null
  }
  return null
}

// Parse an X.509 Distinguished Name string (RFC 4514 subset) into its CN and O
// fields. Handles quoted values ("Acme, Inc."), escaped commas (Acme\, Inc.),
// and both newline- and comma-separated layouts seen from X509Certificate.
// Returns { cn, o } with null fields if absent.
export function parseDn(dnStr) {
  if (!dnStr || typeof dnStr !== 'string') return { cn: null, o: null }
  return {
    cn: extractRdn(dnStr, 'CN'),
    o: extractRdn(dnStr, 'O'),
  }
}

// Parse the first X.509 certificate from a PEM buffer and return a CertSummary.
// node:crypto.X509Certificate returns .subject and .issuer as DN strings, so we
// run them through parseDn to extract CN/O. Returns null (not throws) for any
// parse failure — callers (wizard and validator) branch on null explicitly and
// surface a user-facing message; exception-per-input noise would complicate
// that flow without adding information.
export function parseCertFromPem(pemBytes) {
  if (!pemBytes || pemBytes.length === 0) return null
  let x509
  try {
    x509 = new X509Certificate(pemBytes)
  } catch {
    return null
  }
  const subject = parseDn(x509.subject)
  const issuer = parseDn(x509.issuer)
  return {
    subject: subject.cn,
    issuerCN: issuer.cn,
    issuerOrg: issuer.o,
    validFrom: x509.validFrom || null,
    validTo: x509.validTo || null,
    fingerprint: x509.fingerprint256 || x509.fingerprint || null,
    san: x509.subjectAltName || null,
    selfSigned: Boolean(
      subject.cn && issuer.cn &&
        subject.cn === issuer.cn &&
        (!issuer.o || issuer.o === subject.o),
    ),
  }
}

// Verify a CA bundle validates a live server's TLS cert. Returns {ok} plus,
// on failure, the server cert (for diagnostics) and the authorization error
// string from OpenSSL. Uses a single TLS handshake: a split raw-probe +
// validate would leave a TOCTOU window where the cert the user sees in the
// banner differs from the cert we actually validated.
export async function validateCaAgainstServer({ caBytes, host, port }) {
  const probe = await probeTls({ host, port, ca: caBytes })
  if (!probe.reachable) {
    return { ok: false, kind: 'unreachable', error: probe.error ?? 'unknown' }
  }
  if (probe.caUntrusted) {
    return {
      ok: false,
      kind: 'untrusted',
      serverCert: probe.cert,
      error: probe.error ?? 'unauthorized',
    }
  }
  // caBytes is the same reference the caller gave us, "laundered" through a
  // live server-chain check. Consumers see it as ValidatedCaBytes — the brand
  // is the type-level receipt that these bytes matched the server.
  return { ok: true, serverCert: probe.cert, caBytes }
}
