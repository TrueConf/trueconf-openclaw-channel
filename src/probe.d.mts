// Type declarations for probe.mjs — production probe/CA/OAuth helpers.
// Authored here so wizard code (`channel-setup.ts`) can import them under strict TS.

export interface ProbeTlsResult {
  reachable: boolean
  useTls: boolean
  port: number
  caUntrusted: boolean
  caChain?: string[]
  error?: string
}

export interface ProbeTlsParams {
  host: string
  port?: number
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
