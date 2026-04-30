/**
 * Setup-only loading point for the TrueConf channel wizard.
 *
 * OpenClaw's `plugins install` / `plugins setup` / `channels list` / `onboard`
 * commands load this entry (via the `openclaw.setupEntry` field in
 * package.json) to drive admin flows without pulling in the full channel
 * runtime. From openclaw 2026.4.21+, these surfaces also call
 * `plugin.config.{listAccountIds, defaultAccountId, resolveAccount,
 * isConfigured, isEnabled, describeAccount}` and `plugin.setup.applyAccountConfig`
 * — so the setup-only entry MUST ship the FULL ChannelPlugin shape, not just
 * id+meta+setupWizard.
 *
 * Logic shared with src/channel.ts (full-runtime entry): both consume
 * createTrueconfPluginBase(...) from src/plugin-base.ts to keep the surface
 * identical across the two entry points.
 */
import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/core'
import { trueconfSetupWizard } from './channel-setup'
import { createTrueconfPluginBase } from './plugin-base'
import { trueconfSetupAdapter } from './setup-shared'

export default defineSetupPluginEntry(
  createTrueconfPluginBase({
    setupWizard: trueconfSetupWizard,
    setup: trueconfSetupAdapter,
  }),
)
