import type { TrueConfAccountConfig } from './types'

export const PROTOCOL_VERSION = 1 as const

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface SerializedError {
  name: string
  message: string
  code?: string
  parkable: boolean
  stack?: string
}

export type TerminalCause =
  | { kind: 'dns_exhausted' }
  | { kind: 'auth_exhausted' }
  | { kind: 'shutdown' }
  | { kind: 'main_unresponsive' }
  | { kind: 'fatal'; message: string }

export interface WsCoreConfig {
  account: TrueConfAccountConfig
  heartbeatIntervalMs?: number
  heartbeatPongTimeoutMs?: number
  tcpKeepAliveMs?: number
  oauthTimeoutMs?: number
  wsHandshakeTimeoutMs?: number
  dnsFailLimit?: number
  oauthFailLimit?: number
}

export type MainToWorker =
  | { kind: 'init'; protocolVersion: 1 }
  | { kind: 'sendRequest'; reqId: number; method: string; payload: unknown; timeoutMs?: number }
  | { kind: 'forceReconnect'; reason: string }
  | { kind: 'fileProgressSubscribe'; fileId: string }
  | { kind: 'fileProgressUnsubscribe'; fileId: string }
  | { kind: 'appPing'; nonce: number }
  | { kind: 'shutdown'; reason?: string }

export type WorkerToMain =
  | { kind: 'ready'; protocolVersion: 1 }
  | { kind: 'state'; state: 'connecting' | 'reconnecting' | 'closed'; detail?: string }
  | { kind: 'auth'; botUserId: string }
  | { kind: 'authLost'; reason?: string }
  | { kind: 'inbound'; method: string; payload: unknown }
  | { kind: 'push'; method: string; payload: Record<string, unknown> }
  | { kind: 'response'; reqId: number; ok: true; data: unknown }
  | { kind: 'response'; reqId: number; ok: false; error: SerializedError }
  | { kind: 'fileProgress'; fileId: string; progress: number }
  | { kind: 'appPong'; nonce: number }
  | { kind: 'terminal'; cause: TerminalCause }
  | { kind: 'log'; level: LogLevel; msg: string; meta?: unknown }

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const o = err as Error & { code?: unknown; parkable?: unknown }
    return {
      name: err.name,
      message: err.message,
      code: typeof o.code === 'string' ? o.code : undefined,
      parkable: o.parkable === true,
      stack: err.stack,
    }
  }
  return { name: 'Error', message: String(err), parkable: false }
}

export function deserializeError(s: SerializedError): Error {
  const ctor = ({ TypeError, RangeError, SyntaxError, ReferenceError } as Record<string, ErrorConstructor>)[s.name] ?? Error
  const err = new ctor(s.message)
  if (s.code !== undefined) (err as { code?: string }).code = s.code
  ;(err as { parkable?: boolean }).parkable = s.parkable
  if (s.stack) err.stack = s.stack
  return err
}
