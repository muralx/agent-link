## Purpose

Source of agent-link-edge: mcp-server.ts builds the SDK 1.x Server from tools.ts (the agent tools, including guard and audit) and channel.ts and performs the automatic provisional registration on start, hub-client.ts talks to the hub, hub-launcher.ts starts one when needed, hook.ts implements the plugin hooks, window.ts identifies the Claude Code window the process runs in, config.ts resolves workspace and hub URL, session.ts holds the only mutable state, and bin.ts dispatches between MCP mode and hook mode.
