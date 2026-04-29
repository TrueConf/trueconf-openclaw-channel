import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileUploadLimits } from '../../src/limits'
import { BoundedSeen, handleSdkPushEvent } from '../../src/push-events'

interface TestCtx {
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  limits: { updateFromServer: ReturnType<typeof vi.fn> }
  invalidateChatState: ReturnType<typeof vi.fn>
  ctx: {
    logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
    limits: FileUploadLimits
    invalidateChatState: ReturnType<typeof vi.fn>
    seenUnknownMethods: BoundedSeen
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
      seenUnknownMethods: new BoundedSeen(),
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
    it('returns false for unknown method', () => {
      const t = makeCtx()
      const handled = handleSdkPushEvent('unique-method', {}, t.ctx)
      expect(handled).toBe(false)
    })

    it('logs info exactly once for the same unknown method called 100 times', () => {
      const t = makeCtx()
      for (let i = 0; i < 100; i++) {
        handleSdkPushEvent('flibbertigibbet', {}, t.ctx)
      }
      expect(t.logger.info).toHaveBeenCalledTimes(1)
    })

    it('LRU eviction: 33 unique methods cause oldest to be re-loggable', () => {
      const t = makeCtx()
      // Cache starts empty (per-account, not module-scoped). Push 33 unique
      // method-* entries through a 32-slot LRU:
      //   - method-0..31 fill cache → [method-0..31] FIFO
      //   - method-32 evicts method-0 → cache: [method-1..32]
      for (let i = 0; i < 33; i++) {
        handleSdkPushEvent(`method-${i}`, {}, t.ctx)
      }
      expect(t.logger.info).toHaveBeenCalledTimes(33) // each unique = one info

      // method-0 was evicted; re-pushing it logs again.
      handleSdkPushEvent('method-0', {}, t.ctx)
      expect(t.logger.info).toHaveBeenCalledTimes(34)

      // method-32 was the most recent insertion before re-adding method-0
      // (which evicted method-1). Still in cache → no new log.
      handleSdkPushEvent('method-32', {}, t.ctx)
      expect(t.logger.info).toHaveBeenCalledTimes(34)
    })

    it('two contexts (e.g. two accounts) maintain independent LRU state', () => {
      const a = makeCtx()
      const b = makeCtx()
      handleSdkPushEvent('shared-method', {}, a.ctx)
      handleSdkPushEvent('shared-method', {}, a.ctx) // dedup'd in a
      handleSdkPushEvent('shared-method', {}, b.ctx) // first time in b
      expect(a.logger.info).toHaveBeenCalledTimes(1)
      expect(b.logger.info).toHaveBeenCalledTimes(1)
    })
  })
})
