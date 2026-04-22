/**
 * Setup-only loading point for the TrueConf channel wizard.
 *
 * OpenClaw's `plugins install` / `plugins setup` commands load this entry
 * (via the `openclaw.setupEntry` field in package.json) to drive the admin
 * wizard without pulling in the full channel runtime. All interactive
 * wiring lives in `src/channel-setup.ts`.
 */
import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/core'
import { trueconfSetupWizard } from './channel-setup'

// Meta kept in sync with package.json → openclaw.channel and src/channel.ts.
// Required because the SDK wizard runtime reads plugin.meta.label at render
// time; an undefined meta would throw "Cannot read properties of undefined
// (reading 'label')". Reference plugins (telegram/imessage/signal/discord)
// all pass a full ChannelPlugin base — this is the minimal inline mirror.
export default defineSetupPluginEntry({
  id: 'trueconf',
  meta: {
    id: 'trueconf',
    label: 'TrueConf',
    selectionLabel: 'TrueConf Server',
    docsPath: '/channels/trueconf',
    blurb: 'Connect OpenClaw to TrueConf Server corporate messenger.',
    order: 80,
    aliases: ['tc'],
  },
  setupWizard: trueconfSetupWizard,
})
