import type { Logger } from './types'

// Asks the server for one user's display name; null when it has none.
export type DisplayNameLookup = (userId: string) => Promise<string | null>

export interface DisplayNameTimings {
  // How long a found name is kept.
  ttlMs: number
  // How long a failed, empty or slow lookup answers with the userId before
  // the server is asked again.
  retryMs: number
  // The longest a caller waits for an answer.
  timeoutMs: number
}

const DEFAULT_TIMINGS: DisplayNameTimings = { ttlMs: 60 * 60 * 1000, retryMs: 5 * 60 * 1000, timeoutMs: 3_000 }

// TrueConf display names for one account, keyed by userId. resolve() never
// rejects and never waits longer than the timeout; without a name it yields
// the userId. A lookup that outlives the timeout still fills the cache.
export class DisplayNames {
  private readonly cache = new Map<string, { name: string; expiresAt: number }>()
  private readonly inflight = new Map<string, Promise<string | null>>()

  constructor(
    private readonly lookup: DisplayNameLookup,
    private readonly logger: Logger,
    private readonly timings: DisplayNameTimings = DEFAULT_TIMINGS,
  ) {}

  async resolve(userId: string): Promise<string> {
    const cached = this.fresh(userId)
    if (cached !== undefined) return cached
    let pending = this.inflight.get(userId)
    if (!pending) {
      pending = this.fetch(userId)
      this.inflight.set(userId, pending)
    }
    const name = await withTimeout(pending, this.timings.timeoutMs)
    if (name === null && this.fresh(userId) === undefined) this.remember(userId, userId, this.timings.retryMs)
    return name ?? userId
  }

  private async fetch(userId: string): Promise<string | null> {
    try {
      const name = await this.lookup(userId)
      if (name) this.remember(userId, name, this.timings.ttlMs)
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

  private fresh(userId: string): string | undefined {
    const hit = this.cache.get(userId)
    return hit && hit.expiresAt > Date.now() ? hit.name : undefined
  }

  private remember(userId: string, name: string, forMs: number): void {
    this.cache.set(userId, { name, expiresAt: Date.now() + forMs })
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
