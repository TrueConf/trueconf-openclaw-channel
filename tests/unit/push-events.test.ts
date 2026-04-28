import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileUploadLimits } from '../../src/limits'
import { handleSdkPushEvent } from '../../src/push-events'

interface TestCtx {
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  limits: { updateFromServer: ReturnType<typeof vi.fn> }
  invalidateChatState: ReturnType<typeof vi.fn>
  ctx: {
    logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
    limits: FileUploadLimits
    invalidateChatState: ReturnType<typeof vi.fn>
  }
}

const makeCtx = (): TestCtx => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const limits = { updateFromServer: vi.fn() }
  const invalidateChatState = vi.fn()
  return {
    logger,
    limits,
    invalidateChatState,
    ctx: {
      logger,
      limits: limits as unknown as FileUploadLimits,
      invalidateChatState,
    },
  }
}

describe('handleSdkPushEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getFileUploadLimits', () => {
    it('forwards valid payload to limits.updateFromServer', () => {
      const t = makeCtx()
      const payload = { maxSize: 1_000_000, extensions: { mode: 'allow', list: ['pdf'] } }
      const handled = handleSdkPushEvent('getFileUploadLimits', payload, t.ctx)
      expect(handled).toBe(true)
      expect(t.limits.updateFromServer).toHaveBeenCalledWith(payload)
    })

    it('forwards maxSize=null payload (limits handles corruption itself)', () => {
      const t = makeCtx()
      handleSdkPushEvent('getFileUploadLimits', { maxSize: null, extensions: null }, t.ctx)
      expect(t.limits.updateFromServer).toHaveBeenCalled()
    })
  })

  describe('removeChat', () => {
    it('valid chatId: invokes invalidateChatState', () => {
      const t = makeCtx()
      const handled = handleSdkPushEvent('removeChat', { chatId: 'chat-X' }, t.ctx)
      expect(handled).toBe(true)
      expect(t.invalidateChatState).toHaveBeenCalledWith('chat-X')
      expect(t.logger.warn).not.toHaveBeenCalled()
    })

    it('missing chatId: warn, no invalidate', () => {
      const t = makeCtx()
      const handled = handleSdkPushEvent('removeChat', {}, t.ctx)
      expect(handled).toBe(true)
      expect(t.invalidateChatState).not.toHaveBeenCalled()
      expect(t.logger.warn).toHaveBeenCalled()
    })
  })

  describe('editMessage (parsed-and-dropped, no callback in v1.2.0)', () => {
    it('valid payload: logger.info summary, no warn', () => {
      const t = makeCtx()
      // Wire shape matches python-trueconf-bot edited_message.py: `content`, not `newContent`.
      const payload = { chatId: 'c1', timestamp: 1234, content: { text: 'edited', parseMode: 'markdown' } }
      const handled = handleSdkPushEvent('editMessage', payload, t.ctx)
      expect(handled).toBe(true)
      expect(t.logger.info).toHaveBeenCalled()
      expect(t.logger.warn).not.toHaveBeenCalled()
    })

    it('invalid payload (missing chatId): warn, no info', () => {
      const t = makeCtx()
      handleSdkPushEvent('editMessage', { timestamp: 1, content: { text: 'x' } }, t.ctx)
      expect(t.logger.warn).toHaveBeenCalled()
      expect(t.logger.info).not.toHaveBeenCalled()
    })

    it('rejects payload using internal-only field name "newContent" (regression: must use wire name "content")', () => {
      const t = makeCtx()
      // The internal ChatMutationEvent uses `newContent` for post-edit semantics,
      // but that name MUST NOT leak to the wire validator: TrueConf's protocol
      // sends `content`. A payload carrying only `newContent` is malformed.
      const payload = { chatId: 'c1', timestamp: 1234, newContent: { text: 'edited', parseMode: 'markdown' } }
      handleSdkPushEvent('editMessage', payload, t.ctx)
      expect(t.logger.warn).toHaveBeenCalled()
      expect(t.logger.info).not.toHaveBeenCalled()
    })
  })

  describe('removeMessage (parsed-and-dropped)', () => {
    it('valid payload with removedBy: logger.info', () => {
      const t = makeCtx()
      const handled = handleSdkPushEvent(
        'removeMessage',
        { chatId: 'c1', messageId: 'm1', removedBy: { id: 'u1', type: 1 } },
        t.ctx,
      )
      expect(handled).toBe(true)
      expect(t.logger.info).toHaveBeenCalled()
      expect(t.logger.warn).not.toHaveBeenCalled()
    })

    it('missing messageId: warn, no info', () => {
      const t = makeCtx()
      handleSdkPushEvent('removeMessage', { chatId: 'c1' }, t.ctx)
      expect(t.logger.warn).toHaveBeenCalled()
      expect(t.logger.info).not.toHaveBeenCalled()
    })
  })

  describe('clearHistory (parsed-and-dropped, forAll coercion)', () => {
    it('forAll=true (boolean): info logged with forAll:true', () => {
      const t = makeCtx()
      handleSdkPushEvent('clearHistory', { chatId: 'c1', forAll: true }, t.ctx)
      expect(t.logger.info).toHaveBeenCalled()
      const msg = String(t.logger.info.mock.calls[0]?.[0] ?? '')
      expect(msg).toContain('true')
    })

    it('forAll="true" (string): coerced to true in log', () => {
      const t = makeCtx()
      handleSdkPushEvent('clearHistory', { chatId: 'c1', forAll: 'true' }, t.ctx)
      expect(t.logger.info).toHaveBeenCalled()
      const msg = String(t.logger.info.mock.calls[0]?.[0] ?? '')
      expect(msg).toContain('true')
    })

    it('forAll=false (boolean): info logged with forAll:false', () => {
      const t = makeCtx()
      handleSdkPushEvent('clearHistory', { chatId: 'c1', forAll: false }, t.ctx)
      const msg = String(t.logger.info.mock.calls[0]?.[0] ?? '')
      expect(msg).toContain('false')
    })

    it('missing chatId: warn, no info', () => {
      const t = makeCtx()
      handleSdkPushEvent('clearHistory', { forAll: true }, t.ctx)
      expect(t.logger.warn).toHaveBeenCalled()
      expect(t.logger.info).not.toHaveBeenCalled()
    })
  })

  describe('unknown methods (BoundedSeen LRU)', () => {
    // Use unique method-name prefixes per test to keep the module-scoped LRU
    // cache from leaking state across cases. Each test's namespace is disjoint
    // from the others, so prior test additions don't flip these expectations.
    it('returns false for unknown method', () => {
      const t = makeCtx()
      const handled = handleSdkPushEvent('dedup-A-unique-method', {}, t.ctx)
      expect(handled).toBe(false)
    })

    it('logs info exactly once for the same unknown method called 100 times', () => {
      const t = makeCtx()
      for (let i = 0; i < 100; i++) {
        handleSdkPushEvent('dedup-B-flibbertigibbet', {}, t.ctx)
      }
      expect(t.logger.info).toHaveBeenCalledTimes(1)
    })

    it('LRU eviction: 33 unique methods cause oldest to be re-loggable', () => {
      const t = makeCtx()
      // Pre-wash: dispatch 32 unique throwaway methods to fill the module-scoped
      // seenUnknownMethods cache to capacity. This flushes any prior pollution
      // (e.g. dedup-A-* / dedup-B-* / lru-C-* from previously-run tests in this
      // file or future tests added before this one) so the cache holds ONLY
      // prewash-* keys when the actual test logic begins. Without this, the
      // arithmetic below is order-dependent.
      for (let i = 0; i < 32; i++) {
        handleSdkPushEvent(`prewash-${i}`, {}, t.ctx)
      }
      // Reset mock counters AFTER pre-wash so subsequent expect(...).toHaveBeenCalledTimes(N)
      // counts only the methods this test explicitly pushes.
      vi.clearAllMocks()

      // Cache state at this point: [prewash-0..31] (FIFO order).
      // Push 33 unique lru-C-method-* entries:
      //   - lru-C-method-0  evicts prewash-0  → cache: [prewash-1..31, lru-C-method-0]
      //   - lru-C-method-1  evicts prewash-1  → cache: [prewash-2..31, lru-C-method-0..1]
      //   - ...
      //   - lru-C-method-31 evicts prewash-31 → cache: [lru-C-method-0..31]
      //   - lru-C-method-32 evicts lru-C-method-0 → cache: [lru-C-method-1..32]
      // So lru-C-method-0 is evicted at the end; lru-C-method-32 is most recent.
      for (let i = 0; i < 33; i++) {
        handleSdkPushEvent(`lru-C-method-${i}`, {}, t.ctx)
      }
      expect(t.logger.info).toHaveBeenCalledTimes(33) // each unique = one info

      // lru-C-method-0 was just evicted; re-pushing it logs again.
      handleSdkPushEvent('lru-C-method-0', {}, t.ctx)
      expect(t.logger.info).toHaveBeenCalledTimes(34)

      // lru-C-method-32 was the most recent insertion before the re-add of
      // lru-C-method-0 (which evicted lru-C-method-1). It's still in cache → no new log.
      handleSdkPushEvent('lru-C-method-32', {}, t.ctx)
      expect(t.logger.info).toHaveBeenCalledTimes(34)
    })
  })
})
