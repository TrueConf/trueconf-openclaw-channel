// Type declarations for probe.mjs — production probe/CA/OAuth helpers.
// Authored here so wizard code (`channel-setup.ts`) can import them under strict TS.

// Nominal brand for CA bytes that have passed server-chain validation
// in-process. Only validateCaAgainstServer produces this type (on ok:true);
// validateOAuthCredentials refuses anything else. Turns the TOCTOU invariant
// ("pass the bytes you validated, not a disk re-read") into a compile-time
// guarantee rather than a code-review convention.
export type ValidatedCaBytes = Uint8Array & { readonly __brand: 'ValidatedCa' }

export type ProbeTlsResult =
  | { reachable: false; useTls: false; port: number; caUntrusted: false; error: string }
  | { reachable: true; useTls: false; port: number; caUntrusted: false }
  | {
      reachable: true
      useTls: true
      port: number
      caUntrusted: false
      cert?: CertSummary
      caChain?: string[]
    }
  | {
      reachable: true
      useTls: true
      port: number
      caUntrusted: true
      cert?: CertSummary
      caChain?: string[]
      error: string
    }

export interface ProbeTlsParams {
  host: string
  port?: number
  ca?: Buffer | Uint8Array
}

export function probeTls(params: ProbeTlsParams): Promise<ProbeTlsResult>

export interface DownloadCaChainParams {
  host: string
  port?: number
}

export function downloadCAChain(params: DownloadCaChainParams): Promise<string>

export type OAuthCategory =
  | 'invalid-credentials'
  | 'token-endpoint-missing'
  | 'server-error'
  | 'network'
  | 'tls'
  | 'unknown'

export type ValidateOAuthCredentialsResult =
  | { ok: true }
  | { ok: false; category: OAuthCategory; error: string }

export interface ValidateOAuthCredentialsParams {
  serverUrl: string
  username: string
  password: string
  useTls?: boolean
  port?: number
  ca?: ValidatedCaBytes
}

export function validateOAuthCredentials(
  params: ValidateOAuthCredentialsParams,
): Promise<ValidateOAuthCredentialsResult>

export function parseDn(dnStr: string | null | undefined): {
  cn: string | null
  o: string | null
}

export interface CertSummary {
  subject: string | null
  issuerCN: string | null
  issuerOrg: string | null
  validFrom: string | null
  validTo: string | null
  fingerprint: string | null
  san: string | null
  selfSigned: boolean
}

export function parseCertFromPem(
  pemBytes: Buffer | Uint8Array,
): CertSummary | null

export interface ValidateCaAgainstServerParams {
  caBytes: Buffer | Uint8Array
  host: string
  port?: number
}

export type ValidateCaAgainstServerResult =
  | { ok: true; serverCert?: CertSummary; caBytes: ValidatedCaBytes }
  | {
      ok: false
      kind: 'unreachable' | 'untrusted'
      serverCert?: CertSummary
      error: string
    }

export function validateCaAgainstServer(
  params: ValidateCaAgainstServerParams,
): Promise<ValidateCaAgainstServerResult>
