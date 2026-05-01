import type { Logger, TrueConfResponse } from './types'

interface WsClientLike {
  sendRequest(method: string, payload: Record<string, unknown>): Promise<TrueConfResponse>
  onAuth(listener: () => void): () => void
}

interface PendingItem {
  id: string
  method: string
  payload: Record<string, unknown>
  resolve: (response: TrueConfResponse) => void
  reject: (err: Error) => void
  attempts: number
}

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
      }
      this.pending.set(item.id, item)
      void this.attempt(item)
    })
  }

  private async attempt(item: PendingItem): Promise<void> {
    if (!this.pending.has(item.id)) return
    item.attempts++
    try {
      const response = await this.client.sendRequest(item.method, item.payload)
      if (this.pending.delete(item.id)) item.resolve(response)
    } catch (err) {
      if (this.isReconnectable(err)) {
        // Park: keep item in `pending`, do not resolve or reject. Drain will
        // re-attempt when the next auth event fires.
        this.logger.info(
          `[trueconf] outbound parked: method=${item.method} attempt=${item.attempts} ` +
          `reason=${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      if (this.pending.delete(item.id)) {
        item.reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  private isReconnectable(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return (
      message.includes('WebSocket is not connected') ||
      message.startsWith('WebSocket closed:') ||
      message.startsWith('auth barrier reset') ||
      message.startsWith('waitAuthenticated timed out') ||
      message === 'New connection started'
    )
  }

  private async drain(): Promise<void> {
    if (this.draining || this.terminalError) return
    this.draining = true
    try {
      const items = Array.from(this.pending.values())
      for (const item of items) {
        if (this.terminalError) break
        if (!this.pending.has(item.id)) continue
        await this.attempt(item)
      }
    } finally {
      this.draining = false
    }
  }
}
