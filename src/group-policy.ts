import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from 'openclaw/plugin-sdk/channel-policy'
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core'
import type { TrueConfChannelConfig, TrueConfGroupEntry } from './types'

const CHANNEL = 'trueconf'

// What this instance does with a message in a group chat. OpenClaw leaves
// group policy to external channel plugins, so the inbound gate applies it
// before any download, recording or dispatch.
export type GroupAccess =
  // Not this instance's group: drop the message silently.
  | { kind: 'unserved'; reason: string }
  // groupPolicy "allowlist" and the sender is not listed.
  | { kind: 'sender-blocked' }
  | { kind: 'served'; requireMention: boolean }

interface GroupParams {
  cfg: OpenClawConfig
  accountId: string | null | undefined
  chatId: string
  // The chat is listed in groupAlwaysRespondIn.
  alwaysRespond: boolean
}

export function resolveGroupAccess(params: GroupParams & { senderId: string }): GroupAccess {
  const section = (params.cfg.channels?.trueconf ?? {}) as TrueConfChannelConfig
  const fallbackSenders = nonEmpty(section.groupAllowFrom) ?? nonEmpty(section.allowFrom)
  const policy = resolveChannelGroupPolicy({
    cfg: params.cfg,
    channel: CHANNEL,
    groupId: params.chatId,
    accountId: params.accountId,
    groupIdCaseInsensitive: true,
    hasGroupAllowFrom: fallbackSenders !== undefined,
  })
  if (!policy.allowed) return { kind: 'unserved', reason: unservedReason(section) }

  // OpenClaw types only the entry fields core reads; the object is the
  // configured entry, so enabled and allowFrom are there too.
  const entry = policy.groupConfig as TrueConfGroupEntry | undefined
  const defaults = policy.defaultConfig as TrueConfGroupEntry | undefined
  if ((entry ?? defaults)?.enabled === false) {
    return { kind: 'unserved', reason: 'disabled in channels.trueconf.groups' }
  }

  if (section.groupPolicy === 'allowlist') {
    const senders = nonEmpty(entry?.allowFrom) ?? nonEmpty(defaults?.allowFrom) ?? fallbackSenders ?? []
    if (!senders.includes('*') && !senders.includes(params.senderId)) return { kind: 'sender-blocked' }
  }
  return { kind: 'served', requireMention: groupRequiresMention(params) }
}

// One rule for the inbound gate and the groups.resolveRequireMention adapter:
// a group is always-on when groupAlwaysRespondIn lists it or its groups entry
// (or "*") sets requireMention: false.
export function groupRequiresMention(params: GroupParams): boolean {
  return !params.alwaysRespond && resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: CHANNEL,
    groupId: params.chatId,
    accountId: params.accountId,
    groupIdCaseInsensitive: true,
  })
}

function unservedReason(section: TrueConfChannelConfig): string {
  if (section.groupPolicy === 'disabled') return 'groupPolicy is "disabled"'
  if (section.groups && Object.keys(section.groups).length > 0) return 'not listed in channels.trueconf.groups'
  return 'groupPolicy is "allowlist" with no groups and no groupAllowFrom'
}

function nonEmpty(list: string[] | undefined): string[] | undefined {
  return list && list.length > 0 ? list : undefined
}
