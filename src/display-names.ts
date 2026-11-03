import type { Logger } from './types'

const TTL_MS = 60 * 60 * 1000
const TIMEOUT_MS = 3_000

// Asks the server for one user's display name; null when it has none.
export type DisplayNameLookup = (userId: string) => Promise<string | null>

// TrueConf display names for one account, keyed by userId. resolve() never
// rejects and never waits longer than the timeout: a failed, empty or slow
// lookup yields the userId. Failures are not cached, so the next message
// retries; a lookup that outlives the timeout still fills the cache.
export class DisplayNames {
  private readonly cache = new Map<string, { name: string; expiresAt: number }>()
  private readonly inflight = new Map<string, Promise<string | null>>()

  constructor(
    private readonly lookup: DisplayNameLookup,
    private readonly logger: Logger,
    private readonly ttlMs = TTL_MS,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  async resolve(userId: string): Promise<string> {
    const hit = this.cache.get(userId)
    if (hit && hit.expiresAt > Date.now()) return hit.name
    let pending = this.inflight.get(userId)
    if (!pending) {
      pending = this.fetch(userId)
      this.inflight.set(userId, pending)
    }
    return (await withTimeout(pending, this.timeoutMs)) ?? userId
  }

  private async fetch(userId: string): Promise<string | null> {
    try {
      const name = await this.lookup(userId)
      if (name) this.cache.set(userId, { name, expiresAt: Date.now() + this.ttlMs })
      return name
    } catch (err) {
      this.logger.warn(
        `[trueconf] getUserDisplayName failed for ${userId}: ${err instanceof Error ? err.message : String(err)}; using the id`,
      )
      return null
    } finally {
      this.inflight.delete(userId)
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
