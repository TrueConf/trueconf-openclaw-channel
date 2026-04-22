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
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core"
import { channelPlugin, registerFull } from "./src/channel"

export default defineChannelPluginEntry({
  id: "trueconf",
  name: "TrueConf Channel",
  description: "Connect OpenClaw to TrueConf Server corporate messenger.",
  plugin: channelPlugin,
  registerFull,
})
