// Factory mirroring openclaw's createSignalPluginBase pattern. Both
// src/setup-entry.ts (setup-only entry path) and src/channel.ts (full-runtime
// path) consume this so plugin.config / plugin.setup / plugin.setupWizard are
// identical across both surfaces. openclaw 2026.4.21+ routes `channels list`
// and `onboard` through the setup-only entry expecting `plugin.config.{listAccountIds,
// defaultAccountId, resolveAccount, isConfigured, isEnabled, describeAccount}` —
// without these the runtime crashes with TypeError on undefined.
import { createChannelPluginBase } from 'openclaw/plugin-sdk/core'
import type { ChannelSetupAdapter, ChannelSetupWizard } from 'openclaw/plugin-sdk/setup'
import {
  listAccountIds as listAccountIdsImpl,
  resolveAccount as resolveAccountImpl,
  isConfigured as isConfiguredImpl,
  isEnabled as isEnabledImpl,
  describeAccount as describeAccountImpl,
} from './config'
import type { TrueConfChannelConfig, ResolvedAccount } from './types'

const CHANNEL_ID = 'trueconf'

function getChannelConfig(cfg: unknown): TrueConfChannelConfig {
  return ((cfg as { channels?: { trueconf?: unknown } })?.channels?.trueconf ?? {}) as TrueConfChannelConfig
}

export interface CreateTrueconfPluginBaseParams {
  setupWizard: ChannelSetupWizard
  setup: ChannelSetupAdapter
}

export function createTrueconfPluginBase(params: CreateTrueconfPluginBaseParams) {
  return createChannelPluginBase<ResolvedAccount>({
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: 'TrueConf',
      selectionLabel: 'TrueConf Server',
      docsPath: '/channels/trueconf',
      blurb: 'Connect OpenClaw to TrueConf Server corporate messenger.',
      order: 80,
      aliases: ['tc'],
    },
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ['direct', 'group'] as ('direct' | 'group' | 'thread')[],
      reactions: false,
      threads: false,
      media: true,
      polls: false,
      nativeCommands: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: ['channels.trueconf'] },
    config: {
      listAccountIds: (cfg: unknown) => listAccountIdsImpl(getChannelConfig(cfg)),
      // Required by openclaw 2026.4.21+ onboard at onboard-channels-*.js:275
      // (`plugin.config.defaultAccountId?.(cfg) ?? plugin.config.listAccountIds(cfg)[0] ?? "default"`).
      defaultAccountId: (cfg: unknown) =>
        listAccountIdsImpl(getChannelConfig(cfg))[0] ?? 'default',
      resolveAccount: (cfg: unknown, accountId?: string | null) =>
        resolveAccountImpl(getChannelConfig(cfg), accountId),
      isConfigured: (account: ResolvedAccount) => isConfiguredImpl(account),
      isEnabled: (account: ResolvedAccount) => isEnabledImpl(account),
      describeAccount: (account: ResolvedAccount) => describeAccountImpl(account),
    },
    setup: params.setup,
  })
}
