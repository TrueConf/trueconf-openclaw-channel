import { describe, it, expect } from 'vitest'
import { channelPlugin } from '../../src/channel'

// The OpenClaw SDK's tools.message pipeline calls `resolveMessagingTarget`,
// which short-circuits to a normalized-target result iff the plugin's
// `messaging.targetResolver.looksLikeId` returns true. Without it, the SDK's
// default regex never matches `user@host` TrueConf JIDs and the tool errors
// with `Unknown target` before the plugin's sendText/sendMedia is invoked —
// which is why the self-send redirect never fired in production.
describe('channelPlugin.messaging', () => {
  it('normalizeTarget strips the /resource suffix from federated JIDs', () => {
    const fn = channelPlugin.messaging?.normalizeTarget
    expect(typeof fn).toBe('function')
    expect(fn!('openclaw_test@bots.trueconf.com/fe572107')).toBe(
      'openclaw_test@bots.trueconf.com',
    )
  })

  it('normalizeTarget leaves bare JIDs untouched', () => {
    const fn = channelPlugin.messaging?.normalizeTarget
    expect(fn!('alice@srv')).toBe('alice@srv')
  })

  it('normalizeTarget trims whitespace', () => {
    const fn = channelPlugin.messaging?.normalizeTarget
    expect(fn!('  alice@srv/xyz  ')).toBe('alice@srv')
  })

  it('targetResolver.looksLikeId accepts JIDs with a resource', () => {
    const fn = channelPlugin.messaging?.targetResolver?.looksLikeId
    expect(typeof fn).toBe('function')
    expect(
      fn!(
        'openclaw_test@bots.trueconf.com/fe572107',
        'openclaw_test@bots.trueconf.com',
      ),
    ).toBe(true)
  })

  it('targetResolver.looksLikeId accepts bare user@host JIDs', () => {
    const fn = channelPlugin.messaging?.targetResolver?.looksLikeId
    expect(fn!('alice@srv', 'alice@srv')).toBe(true)
  })

  it('targetResolver.looksLikeId rejects free-form text that is not a JID', () => {
    const fn = channelPlugin.messaging?.targetResolver?.looksLikeId
    expect(fn!('just some user name', 'just some user name')).toBe(false)
  })

  it('normalizeTarget turns group addresses into group:<chatId>', () => {
    const fn = channelPlugin.messaging!.normalizeTarget
    expect(fn('trueconf:group:e28a99f1c0d34b7a')).toBe('group:e28a99f1c0d34b7a')
    expect(fn('group:e28a99f1c0d34b7a')).toBe('group:e28a99f1c0d34b7a')
    expect(fn(' TrueConf:Group:Grp_A ')).toBe('group:Grp_A')
  })

  it('normalizeTarget strips the trueconf: prefix and /resource from a user JID', () => {
    const fn = channelPlugin.messaging!.normalizeTarget
    expect(fn('trueconf:alice@srv/phone')).toBe('alice@srv')
  })

  it('targetResolver.looksLikeId accepts group:<chatId> and rejects an empty group id', () => {
    const fn = channelPlugin.messaging!.targetResolver.looksLikeId
    expect(fn('trueconf:group:e28a99f1c0d34b7a', 'group:e28a99f1c0d34b7a')).toBe(true)
    expect(fn('group:e28a99f1c0d34b7a', 'group:e28a99f1c0d34b7a')).toBe(true)
    expect(fn('group:', 'group:')).toBe(false)
  })
})
