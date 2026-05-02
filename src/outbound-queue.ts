import { NetworkError } from './types'
import type { Logger, TrueConfResponse } from './types'

export interface WsClientLike {
  sendRequest(
    method: string,
    payload: Record<string, unknown>,
    traceId?: string,
  ): Promise<TrueConfResponse>
  onAuth(listener: () => void): () => void
}

interface PendingItem {
  id: string
  method: string
  payload: Record<string, unknown>
  resolve: (response: TrueConfResponse) => void
  reject: (err: Error) => void
  attempts: number
  inFlight: boolean
}

/**
 * In-memory at-least-once delivery queue for TrueConf outbound requests.
 *
 * FIFO is preserved within the parked-set on each drain. Items submitted
 * concurrently with a drain are not order-guaranteed against parked items
 * (the in-flight drain holds a snapshot of pending IDs at start; a fresh
 * `submit` lands in `pending` but may attempt before the drain finishes).
 */
export class OutboundQueue {
  private readonly pending = new Map<string, PendingItem>()
  private idCounter = 0
  private draining = false
  private terminalError: Error | null = null
  private offAuth: (() => void) | null = null

  constructor(
    private readonly client: WsClientLike,
    private readonly logger: Logger,
  ) {
    this.offAuth = client.onAuth(() => void this.drain())
  }

  async submit(method: string, payload: Record<string, unknown>): Promise<TrueConfResponse> {
    if (this.terminalError) throw this.terminalError
    return new Promise<TrueConfResponse>((resolve, reject) => {
      const item: PendingItem = {
        id: String(++this.idCounter),
        method,
        payload,
        resolve,
        reject,
        attempts: 0,
        inFlight: false,
      }
      this.pending.set(item.id, item)
      const chatId = typeof payload.chatId === 'string' ? payload.chatId : undefined
      const chatIdSeg = chatId === undefined ? '' : ` chatId=${chatId}`
      this.logger.info(`[trueconf] outbound submit: qid=${item.id} method=${method}${chatIdSeg}`)
      void this.attempt(item)
    })
  }

  private async attempt(item: PendingItem): Promise<void> {
    if (!this.pending.has(item.id)) return
    if (item.inFlight) return
    item.attempts++
    item.inFlight = true
    try {
      const response = await this.client.sendRequest(item.method, item.payload, item.id)
      if (this.pending.delete(item.id)) item.resolve(response)
      else this.logger.info(`[trueconf] outbound: response after terminal: method=${item.method}`)
    } catch (err) {
      if (this.isReconnectable(err)) {
        // Park: keep item in `pending`, do not resolve or reject. Drain will
        // re-attempt when the next auth event fires. Skip the park-log if the
        // item was already drained by failAll during the await — the misleading
        // "parked" line would suggest a still-live retry.
        if (!this.pending.has(item.id)) return
        this.logger.info(
          `[trueconf] outbound parked: method=${item.method} attempt=${item.attempts} ` +
          `reason=${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      if (this.pending.delete(item.id)) {
        item.reject(err instanceof Error ? err : new Error(String(err)))
      } else {
        // failAll won the race: caller already saw the rejection. Log so the
        // original wire error isn't silently swallowed.
        this.logger.warn(
          `[trueconf] outbound: non-reconnectable error after terminal: method=${item.method} ` +
          `reason=${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } finally {
      item.inFlight = false
    }
  }

  private isReconnectable(err: unknown): boolean {
    return err instanceof NetworkError && err.parkable === true
  }

  failAll(err: Error): void {
    if (this.terminalError) return
    this.terminalError = err
    const items = Array.from(this.pending.values())
    this.pending.clear()
    if (items.length > 0) {
      this.logger.warn(
        `[trueconf] outbound queue terminal: reason=${err.message} drained=${items.length}`,
      )
    }
    for (const item of items) item.reject(err)
    this.offAuth?.()
    this.offAuth = null
  }

  private async drain(): Promise<void> {
    if (this.draining || this.terminalError) return
    this.draining = true
    try {
      const items = Array.from(this.pending.values())
      for (const item of items) {
        if (this.terminalError) break
        if (!this.pending.has(item.id)) continue
        // Skip items whose previous attempt() is still suspended at
        // `await client.sendRequest(...)`. Re-firing here would issue a
        // duplicate wire-send (203 reconnect race).
        if (item.inFlight) continue
        await this.attempt(item)
      }
    } finally {
      this.draining = false
    }
  }
}
