// Type declarations for probe.mjs — production probe/CA/OAuth helpers.
// Authored here so wizard code (`channel-setup.ts`) can import them under strict TS.

export interface ProbeTlsResult {
  reachable: boolean
  useTls: boolean
  port: number
  caUntrusted: boolean
  caChain?: string[]
  cert?: CertSummary
  error?: string
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
  ca?: Uint8Array
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
  | { ok: true; serverCert?: CertSummary }
  | {
      ok: false
      kind: 'unreachable' | 'untrusted'
      serverCert?: CertSummary
      error: string
    }

export function validateCaAgainstServer(
  params: ValidateCaAgainstServerParams,
): Promise<ValidateCaAgainstServerResult>
