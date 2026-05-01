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
      if (this.pending.delete(item.id)) {
        item.reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  private async drain(): Promise<void> {
    // No-op for now (no parking yet)
  }
}
