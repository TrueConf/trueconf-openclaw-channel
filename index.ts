/**
 * TrueConf Channel Plugin for OpenClaw.
 *
 * Thin entry point: imports channel plugin + registerFull from src/channel.ts,
 * delegates to SDK's defineChannelPluginEntry for registration-mode handling.
 *
 * All plugin logic lives in src/channel.ts.
 * Tests import directly from src/channel.ts for internals.
 *
 * @see src/channel.ts for channelPlugin, registerFull, createRuntimeStore
 */
import { defineChannelPluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core"
import { channelPlugin, registerFull } from "./src/channel"

// Explicit type: the SDK's return type differs between openclaw releases and,
// since 2026.9, mentions configSchema from a private chunk that declaration
// emit cannot name (TS2742). The host reads the runtime object, not this type.
interface TrueconfPluginEntry {
  id: string
  name: string
  description: string
  register: (api: OpenClawPluginApi) => void | Promise<void>
}

const entry: TrueconfPluginEntry = defineChannelPluginEntry({
  id: "trueconf",
  name: "TrueConf Channel",
  description: "Connect OpenClaw to TrueConf Server corporate messenger.",
  plugin: channelPlugin,
  registerFull,
})

export default entry
