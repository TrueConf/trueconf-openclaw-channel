/**
 * Per-chat outbound serialization. When two concurrent reply paths target the
 * same chatId (e.g., user sends two messages in rapid succession), this queue
 * ensures the second `enqueue(chatId, fn)` waits until the first has settled
 * before its `fn` runs — chunks of the two replies don't interleave.
 *
 * Different chatIds run in parallel: enqueue(A, fnA) and enqueue(B, fnB) start
 * concurrently regardless of submission order.
 *
 * Chains survive errors: if fn throws or its returned promise rejects, the next
 * enqueue for the same chatId still runs.
 */
export class PerChatSendQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  async enqueue<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(chatId) ?? Promise.resolve()
    // Run fn whether prev resolved or rejected; tail tracker survives both.
    const run = prev.then(fn, fn)
    // Track the latest tail; .catch suppresses unhandled-rejection from prior
    // failures (the actual rejection still propagates to the awaiter via `run`).
    const tracked = run.catch(() => undefined)
    this.tails.set(chatId, tracked)
    // Cleanup: only delete if we're still the latest tail when settled.
    void tracked.finally(() => {
      if (this.tails.get(chatId) === tracked) {
        this.tails.delete(chatId)
      }
    })
    return run
  }

  size(): number {
    return this.tails.size
  }
}
