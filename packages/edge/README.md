## Purpose

agent-link-edge, the per-session side of agent-link: a stdio MCP server on @modelcontextprotocol/sdk 1.x that exposes the agent-link tools to one Claude Code session, acts as a Claude Code channel by turning hub SSE events into notifications/claude/channel, and doubles as the hook binary (agent-link-edge hook <event>).

Entry point is src/bin.ts. The edge holds the session's agent id and token after register and talks to the hub only through HubClient; it starts a local hub when none answers. It must stay on the SDK 1.x legacy handshake (decision D3 in the [design spec](../../docs/history/specs/2026-10-10-agent-link-v1-design.md#11-decisions)) or Claude Code will not register it as a channel.
