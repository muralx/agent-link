# agent-link v1 — design

Date: 2026-10-10. Status: approved for implementation.

## 1. Purpose

agent-link lets Claude Code agents communicate with each other: one to one, one to many, and
many to many. Each agent identifies itself, states the workspace it belongs to, describes its
responsibility, and lists what it can do. Agents only see other agents in their own workspace.

The motivating scenario: an _architect_ agent is designing the system while a _component
designer_ agent is designing one component in another Claude Code window. The designer asks the
architect a question and keeps working. The architect finishes its current step, answers, and
keeps working. Neither agent ever has to stop to receive a message. A _human_ participant
runs one relay session per workspace so background agents can ask them questions too.

## 2. Requirements (agreed)

| #   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Local first: all agents on one machine in v1. The protocol is transport-agnostic so a networked hub can follow without changing the agent-facing API.                                                                                                                                                                                                                                                                                  |
| R2  | Integration is a Claude Code **plugin**: an MCP server exposing the tools, hooks for delivery and lifecycle, a skill teaching agents how to use peers, a command for the human relay role.                                                                                                                                                                                                                                             |
| R3  | The MCP server acts as a Claude Code **channel** so an idle interactive agent is woken by an incoming message. Hook injection at tool-call, prompt and stop boundaries is the fallback. A blocking wait exists but is never required to receive.                                                                                                                                                                                       |
| R4  | **No interaction forces a party to stop what it is doing.** The sender decides when, if ever, to wait for an answer.                                                                                                                                                                                                                                                                                                                   |
| R5  | Profiles are prose: name, workspace, description, free-text list of what the agent can do ("consult, resolve, execute" are things an agent may say, not protocol enums). Message bodies are plain markdown the hub never interprets.                                                                                                                                                                                                   |
| R6  | **Conversations are the primitive.** Every message belongs to one. The only typed field on a message is the sender's _expectation_: `reply`, `none`, or `updates`, plus a `final` flag.                                                                                                                                                                                                                                                |
| R7  | Workspace is an explicit name declared at registration. One agent belongs to exactly one workspace. An agent sees only peers in its workspace.                                                                                                                                                                                                                                                                                         |
| R8  | One Claude Code **window** = one agent, with a self-declared name unique among online agents in the workspace. Identity is ephemeral: it lives as long as the window, following it through session switches (`/clear`, `/resume`).                                                                                                                                                                                                     |
| R9  | Durable, queryable history: conversations and messages persist in SQLite across hub restarts. Registration (presence) is ephemeral.                                                                                                                                                                                                                                                                                                    |
| R10 | The human is a participant through a **relay session** (`kind: human`), one per workspace, started with a plugin command in a window opened with the channels flag (the relay is idle by nature, so only the channel can wake it). There is no separate human CLI.                                                                                                                                                                     |
| R11 | The plugin is installed once at user scope; a location opts in with `.agent-link.json`. In an enabled location a window **listens from the moment it opens**: the edge registers it provisionally before the model has acted, and the model identifies itself on its first turn, inferring name, responsibility and capabilities from the session and asking the user for a name only when it cannot. Elsewhere the plugin is dormant. |

Out of scope for v1: remote hub, authentication beyond a per-agent local token, headless /
resident service agents (`claude -p` ignores channels), persistent named identities, a UI,
message attachments.

## 3. Architecture

Three ways were considered: (A) one shared hub serving MCP over HTTP; (B) a per-session stdio
MCP _edge_ plus a shared local _hub_ daemon; (C) no daemon, SQLite as the bus. **B was chosen.**
Channels are documented for stdio only, so the MCP side must be a per-session subprocess anyway;
the edge-to-hub link is already the boundary that becomes remote later; and presence falls out of
the edge's lifetime.

```
Claude Code session ──stdio──▶ agent-link-edge ──HTTP + SSE──▶ agent-linkd ──▶ SQLite
   (hooks) ─────────────────▶ agent-link-edge hook <event> ──HTTP──▶ agent-linkd
```

### 3.1 Components

**Plugin `agent-link`** (directory `plugin/`): Claude Code packaging. The repo root carries
`.claude-plugin/marketplace.json` listing `./plugin`, so the repo is added as a local directory
marketplace (`claude plugin marketplace add <checkout>`). The plugin is installed at **user scope** (decision D6): every
session loads it, and `.agent-link.json` decides where it does anything.

- `.claude-plugin/plugin.json` manifest.
- `.mcp.json` starting the edge over stdio by its **PATH binary**: `{ "agent-link": { "type":
"stdio", "command": "agent-link-edge" } }`. The build installs `agent-link-edge` and
  `agent-linkd` onto PATH (`pnpm build && pnpm link:bins`), so the plugin never depends on where
  Claude Code copies the plugin directory. Hooks call the same binary.
- `hooks/hooks.json`: SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (see §6).
- `skills/agent-link/SKILL.md`: a checklist that finds what is missing and asks only for that
  (marker, identity), then how an agent picks peers, chooses an expectation, replies, and when
  to `await`.
- `commands/join.md`: `/agent-link:join [name] [responsibility]`, explicit onboarding for a
  repository without a marker or a session that should identify itself now.
- `commands/human.md`: the `/agent-link:human` relay role (see §7).

**Edge `agent-link-edge`** (`packages/edge`): one process per session, stdio MCP server built on
`@modelcontextprotocol/sdk` **1.x** (legacy handshake; see decision D3). Declares
`capabilities.experimental["claude/channel"]` and `tools`. Holds the session's agent id and
token after `register`. Subscribes to the hub's SSE stream for that agent and turns each inbound
message into a `notifications/claude/channel` notification. Also exposes a `hook` subcommand the
hooks call. In an enabled location it starts the hub if none is running and registers the window
provisionally as soon as its transport is connected (§6.4); elsewhere it is dormant.

**Hub `agent-linkd`** (`packages/hub`): one process per machine. HTTP JSON API on
`127.0.0.1:<port>` (default 8790, configurable), one SSE stream per connected edge, SQLite store.
Enforces workspace visibility and name uniqueness, routes messages, tracks presence and delivery
state. Has no MCP dependency.

**Protocol `agent-link-protocol`** (`packages/protocol`): shared TypeScript types and zod schemas
for the hub API and the tool inputs/outputs. The single source of truth both sides import.

**Store**: SQLite via `node:sqlite` (Node ≥ 24), WAL mode, file
`$XDG_DATA_HOME/agent-link/agent-link.db` (default `~/.local/share/agent-link/`). Inspectable
with the `sqlite3` CLI; that is the debugging surface.

### 3.2 Configuration

- Repo-level `.agent-link.json` (searched upward from the session cwd): `{ "workspace": "name" }`.
  It is the per-location switch: without it the edge never contacts the hub and the hooks exit
  before any network call. It supplies the workspace; `register` may override it explicitly.
  Several repositories share a workspace by using the same name.
- User-level `$XDG_CONFIG_HOME/agent-link/config.json` (optional): `{ "hub": "http://127.0.0.1:8790" }`.
  Pointing it elsewhere is the future remote path.
- Env overrides: `AGENT_LINK_HUB`, `AGENT_LINK_WORKSPACE`, `AGENT_LINK_DATA_DIR`,
  `AGENT_LINK_WINDOW` (window id override for harnesses that spawn several edges under one
  Claude process).
- Read from Claude Code's environment: `CLAUDE_CODE_SESSION_ID` (the edge's own session id;
  observed in plugin MCP server processes on Claude Code 2.1.296, not documented) and
  `CLAUDE_PROJECT_DIR` (source of the provisional name).

## 4. Data model

Tables (SQLite). Ids are random `ag_`, `cv_`, `msg_` prefixed strings.

| Table          | Columns                                                                                                                                                                    | Notes                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `agent`        | id, name, workspace, description, capabilities (text), kind (`agent`\|`human`), session_id, token_hash, status (`online`\|`offline`), registered_at, last_seen, offline_at | Name unique among `online` agents of a workspace (partial unique index). Offline rows remain for history. |
| `conversation` | id, workspace, subject (nullable), created_by, created_at                                                                                                                  |                                                                                                           |
| `participant`  | conversation_id, agent_id, joined_at                                                                                                                                       | PK (conversation_id, agent_id).                                                                           |
| `message`      | id, conversation_id, from_agent, body, expectation (`reply`\|`none`\|`updates`), final (bool), in_reply_to (nullable), created_at                                          |                                                                                                           |
| `delivery`     | message_id, to_agent, state (`queued`\|`notified`\|`read`), via (`channel`\|`hook`\|`await`\|`inbox`\|`conversation`\|`reply`), notified_at, read_at, nag_count            | PK (message_id, to_agent). One row per recipient.                                                         |
| `session`      | session_id, cwd, workspace_hint, agent_id (nullable), created_at                                                                                                           | Written by the SessionStart hook before the agent registers; lets hooks find the agent by `session_id`.   |

Semantics:

- **Addressing is by name within the workspace**, resolved by the hub to the online agent.
  History stores agent ids, so a conversation stays readable after its participants are gone.
- **Participants** are fixed at creation as sender + recipients. A later `send` into the
  conversation naming additional recipients adds them. A reply goes to all participants except
  the sender. Broadcast `to: "*"` means every online peer in the workspace at send time.
- **Sending to a name that is not online fails** (`peer_not_found`, listing online peers). The
  peer list is the truth; tomorrow's `architect` is a different agent. This applies to
  recipients named in `to`. **Existing participants of a conversation are different**: a `reply`
  (or a `send` into an existing conversation) is always written, delivered to the participants
  that are online, and recorded with a `queued` delivery row for those that are offline. The
  result lists `delivered_to` and `offline` so the sender knows. A `queued` row for an offline
  agent is delivered later only if the **same session reclaims that agent** (§5 `register`):
  then the hooks, `inbox` and the SSE replay surface it like any other queued message. If no
  reclaim happens the row stays `queued` forever, as the record that the message was addressed
  to an agent that was gone.
- **Reading by replying**: posting into a conversation (`reply`, or `send` with a
  `conversation_id`) marks every earlier message in that conversation `read` for the poster,
  `via: reply`. Both tools share this one hub code path.
- **`in_reply_to`** is set by `reply`, and by `send` with a `conversation_id`, to the id of the
  latest message in that conversation not authored by the sender, if one exists. Either tool
  also accepts an explicit `in_reply_to` that overrides the rule. It is informational; the
  `await` semantics below do not depend on it.
- **One human per workspace is a convention**, held by the `/agent-link:human` command's
  prompt and the skill. The hub does not enforce it; a second human registration gets a
  suffixed name like any collision.
- **Delivery states**: `queued` on send. `notified` when the edge emitted a channel notification
  or a hook injected the message. `read` when the agent fetched it (`inbox`, `await`,
  `conversation`) or posted a reply in the conversation after it. Hooks surface `queued`
  messages; they also re-surface `notified` messages whose `notified_at` is older than 60 s and
  that are not `read`, at most twice (`nag_count` < 2). Each re-surface sets `notified_at` to
  now and increments `nag_count`, so the second nag comes at least 60 s after the first. This
  exists because a channel notification is fire-and-forget and is silently dropped when the
  session was launched without the channels flag.
- **Open expectation**: a message with `expectation: reply` addressed to agent X is _open_ for X
  until X posts a message in that conversation after it. `updates` is open until a message with
  `final: true` from the recipient. These are derived by query, never stored.

## 5. Agent-facing tools (MCP, served by the edge)

All tools return structured JSON. Errors are `{ error: code, message, hint }`, never thrown as
protocol errors, so the agent can read and act on them.

| Tool            | Input                                                                                                                                                                                                               | Output                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`      | `name`, `description`, `capabilities` (string), `session_id?` (the edge knows its own; the SessionStart hook prints it as a fallback), `workspace?`, `kind?` (`agent` default, `human`), `provisional?` (edge only) | `{ agent_id, name, workspace, kind, peers: [...] }`                                                                      | **The window owns the agent.** The hub reclaims the agent bound to the session id or, for a provisional request, to the edge's window id: same agent id, new token, status `online`. A provisional request against an existing agent only _reconnects_ it (profile untouched); any other request replaces the profile and clears `provisional`. Otherwise a new agent is created. On name collision with another online agent the hub appends `-2`, `-3`; the returned `name` is authoritative. The hub upserts the `session` row, so hooks work even if SessionStart could not reach it. Workspace falls back to `.agent-link.json`, else `workspace_required`. A reclaim that changes the name or the provisional flag of an online agent emits a `peer updated` event instead of `joined`. |
| `peers`         | —                                                                                                                                                                                                                   | `[{ name, description, capabilities, kind, provisional, last_seen }]`                                                    | Online agents in my workspace, excluding me; `provisional` marks a window that has not identified itself yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `send`          | `to: string[] \| "*"`, `body`, `expectation?` (default `none`), `subject?`, `conversation_id?`, `in_reply_to?`, `final?`                                                                                            | `{ message_id, conversation_id, delivered_to: [names], offline: [names] }`                                               | Without `conversation_id` starts a conversation; every name in `to` must be online or the call fails. With `conversation_id`, `to` is optional and adds participants (which must be online; naming one who is already a participant is a no-op); existing participants receive it whether online or not (§4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `reply`         | `conversation_id`, `body`, `expectation?` (default `none`), `in_reply_to?`, `final?`                                                                                                                                | same as `send`                                                                                                           | Sugar for `send` into an existing conversation to its other participants. Marks earlier messages in it `read` for me.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `await`         | `conversation_id?`, `message_id?`, `timeout_s?` (default 600, max 1500)                                                                                                                                             | `{ messages: [...], timed_out }`                                                                                         | Returns as soon as there is at least one matching message for me that I have not `read`: with `conversation_id`, messages in that conversation from other participants; with `message_id`, messages in that message's conversation from other participants created after it; with neither, any message addressed to me. Unread messages that already exist satisfy the wait immediately; otherwise it blocks until one arrives or the timeout passes. Edge long-polls the hub in ≤ 25 s slices and sends MCP progress notifications so Claude Code's idle timeout never trips. Returned messages become `read`.                                                                                                                                                                               |
| `inbox`         | `unread_only?` (default true), `limit?`                                                                                                                                                                             | `{ messages: [...] }`                                                                                                    | Messages addressed to me. Returned messages become `read`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `conversation`  | `conversation_id`, `since?` (a message id; return messages after it)                                                                                                                                                | `{ conversation, participants, messages }`                                                                               | Full thread. Marks the returned messages `read` for me (only those).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `conversations` | `open_only?` (only conversations whose `open_for_me` is non-empty)                                                                                                                                                  | `[{ id, subject, participants, last_message_at, unread, open_for_me: [{ message_id, from, expectation, created_at }] }]` | What I am part of, with what is waiting on me (`open_for_me` lists the open `reply`/`updates` expectations addressed to me, §4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `unregister`    | —                                                                                                                                                                                                                   | `{ ok }`                                                                                                                 | Explicit offline. SessionEnd hook calls the equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Message object as returned everywhere:
`{ id, conversation_id, from, to: [names], body, expectation, final, in_reply_to, created_at }`.

## 6. Delivery and hooks

### 6.1 Channel (primary)

Hub → edge: `GET /v1/agents/{id}/events` (SSE). On connect the hub first sends every delivery
for this agent still in `queued` state, oldest first (this is how a reclaiming edge, which is a
fresh process without a `Last-Event-ID`, receives what arrived while it was away); with a
`Last-Event-ID` header it additionally skips anything at or before that id. Then it streams live
events. Event `message` carries the message plus `conversation.subject` and participant names.
The edge emits:

```
notifications/claude/channel
  content: "architect → you (expects reply) in conversation cv_… «subject»:\n\n<body>"
  meta: { conversation_id, message_id, from, expectation, final }
```

then `POST /v1/deliveries/{message_id}/{agent_id}` `{ state: "notified", via: "channel" }`.
Event `peer` (`joined` / `left`) is emitted as a channel notification only for `joined`, so an
agent learns a new peer exists; `left` is silent (the next `peers` call reflects it).

Channels require the session to be started with the plugin named as a channel, during the
preview with `claude --dangerously-load-development-channels plugin:agent-link@<marketplace>`.
The server `instructions` string tells Claude how to read the tag and to use `reply`.

### 6.2 Hooks (fallback and lifecycle)

All hooks run `agent-link-edge hook <event>` reading the hook JSON on stdin; each completes in
well under a second against the local hub, and exits 0 silently if the hub is unreachable.

| Event              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SessionStart`     | Silent where no workspace resolves. Otherwise upserts `session` (session_id, cwd, workspace hint, **window id**, source) and emits `additionalContext`: the workspace, the session id, and the window's agent state. Provisional: "identify yourself now, inferring name, responsibility and capabilities from this session; ask the user for a name only if you cannot infer one". Identified (after `/clear`, `/compact`, `/resume`): "this window is registered as `<name>`: `<description>`; carry on, or register anew if this session is about something else". None yet: "the edge registers this window provisionally". When the session id was previously bound to a different agent (a resumed conversation), it names that agent too so the model can take the role back. |
| `UserPromptSubmit` | Fetches pending messages for the window's agent (by session id, relinked by window id after a switch): `queued`, or `notified` > 60 s and `nag_count` < 2. Emits `additionalContext` with a one-line summary per message (from, expectation, subject, first 200 chars) and "call `inbox` or `conversation` to read". Marks them `notified` via `hook`. While the agent is still provisional, adds a one-line reminder to identify itself.                                                                                                                                                                                                                                                                                                                                            |
| `PostToolUse`      | Same as above. The hook reads `tool_name` from its stdin and exits silently when the tool belongs to the agent-link server (name contains `agent-link` or `agent_link`), so reading the inbox never triggers a nag; this check lives in the hook, not in the `matcher`, because the exact namespaced tool name a plugin server gets (`mcp__plugin_<plugin>_<server>__…`) is an implementation detail.                                                                                                                                                                                                                                                                                                                                                                                |
| `Stop`             | If `stop_hook_active` is true, or the agent is `kind: human`, exit 0. Otherwise, if there are open `reply` expectations addressed to this agent, return `{ decision: "block", reason: "<n> peers are waiting for your reply: …" }`. Blocks at most once per stop. Reads `GET /v1/sessions/{id}/open`, which **does not touch delivery rows**, so stopping never consumes a message's first surfacing.                                                                                                                                                                                                                                                                                                                                                                                |
| `SessionEnd`       | Calls `POST /v1/sessions/{session_id}/end?window=…`. The hub takes the agent offline **unless its edge still holds an SSE stream**: then the window merely switched sessions (`/clear`) and the agent stays online. This route is session-scoped because the hook process has no agent token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

The hub also marks an agent offline when its SSE stream drops and is not resumed within 30 s.
The edge reconnects with exponential backoff (0.5 s → 10 s).

### 6.3 Why both can coexist

Whichever path surfaces a message first moves its delivery to `notified`; the other finds
nothing `queued`. The 60-second re-surface covers the case where the channel notification was
dropped because the session was not launched as a channel.

### 6.4 Listening from load: provisional registration and the window

The model only acts once the user types, so a window opened and left idle would be unreachable
if registration depended on a tool call. Therefore:

1. **The edge registers at load.** `agent-link-edge` is started by Claude Code with the session
   and reads `CLAUDE_CODE_SESSION_ID` from its environment. Once its stdio transport is
   connected it resolves the workspace; if there is one, it ensures the hub, calls
   `POST /v1/agents` with `provisional: true`, a placeholder name (the project directory's
   basename) and a placeholder description, and opens its SSE stream. From that moment the
   window has a mailbox and the channel wakes it. Without a workspace the edge does nothing.
2. **The model identifies itself** on its first turn, told by the SessionStart context, the
   server instructions and the skill: it infers name, responsibility and capabilities from the
   session and calls `register` (no session id needed). The hub reclaims the provisional row,
   replaces the profile, clears `provisional` and announces `peer updated`. Messages that arrived
   meanwhile are in the inbox; a message delivered to a provisional agent carries an
   "identify yourself first" line.
3. **The window owns the agent.** A window can switch sessions (`/clear`, `/resume`) while its
   edge keeps running, or Claude Code may restart the edge inside the same window. Edge and hook
   processes both descend from the `claude` process, so both compute the same **window id**
   (`<boot id>-<pid>-<start time>` from `/proc`; `AGENT_LINK_WINDOW` overrides it) and send it to
   the hub. The hooks' routes resolve the agent by session id first and otherwise by the live
   agent of that window, relinking it to the new session id; a provisional registration from a
   restarted edge reconnects the window's agent without touching its identity; `SessionEnd`
   leaves an agent online while its edge still holds a stream. The window fallback applies only
   to provisional requests, so an explicit `register` can never hijack another window's agent.
4. **Several edges under one Claude process** (test harnesses) would share a window id; they set
   `AGENT_LINK_WINDOW` per edge. Under Claude Code proper there is one edge per window.
5. **The edge upgrades its own agent.** A hook may relink the window's agent to a new session id
   before the model identifies itself (the window was opened with `--resume`, or `/clear` ran
   first), so the edge's session id no longer matches the row. `register` therefore sends the
   edge's current `agent_id` with its bearer token, and the hub upgrades that very agent; the
   session id is only the fallback for an edge with no identity yet.
6. **The name is the identity within a workspace.** An identified `register` whose name belongs
   to an **offline, identified** agent of the workspace adopts that row: same agent id, its
   conversations, participations and unread deliveries, new session, window and token. The
   window's provisional placeholder, if any, is folded into it (memberships and deliveries
   moved, duplicates dropped, row deleted) and peers see `peer identified: alice (was repo)`.
   A closed relay window reopened later, or a `claude --resume` in a new window, thus finds the
   questions it missed in its inbox. Online namesakes still get the `-2` suffix; offline
   placeholders are never adopted.
7. **No channel without the flag.** Claude Code accepts `notifications/claude/channel` only from
   servers named in `--dangerously-load-development-channels`, and the MCP handshake does not
   reveal whether it was given (client capabilities are identical either way, verified on
   2.1.296). The edge and the hooks read the `claude` ancestor's `/proc/<pid>/cmdline`
   (`AGENT_LINK_CHANNEL=on|off` overrides). Without the flag the edge emits no channel
   notifications and never acks deliveries as notified, so they stay `queued` and the hooks
   surface them; `register` returns `channel: "unavailable"` with a warning and the SessionStart
   context warns too. The human relay command repeats the warning to the person.

## 7. Human relay

`/agent-link:human [name]` is a plugin command whose prompt instructs the session to:

1. `register` with `kind: "human"`, name defaulting to the OS user, description "Human owner of
   this workspace. Ask for decisions, approvals and anything an agent must not decide alone."
   This replaces the provisional identity the edge gave the window; no session id is needed.
2. On every inbound message, print it verbatim with sender, conversation id and expectation, and
   wait. Never answer on the human's behalf, never summarise away content.
3. When the human types, send it with `reply` into the conversation the human indicates (the
   most recent one if not stated), and go idle again.

The Stop hook never blocks a `human` agent (§6.2). Peers see `kind: human` in `peers` and the
skill tells agents that asking a human means human-scale latency, so they should ask for
decisions, not for things they can resolve themselves.

## 8. Hub HTTP API (edge ↔ hub; remote boundary)

All JSON. After `register`, every call carries `Authorization: Bearer <agent token>`; the hub
checks the token matches the agent in the path. Hook calls use the session route, which is
unauthenticated on localhost in v1.

| Method and path                                               | Purpose                                                                                                                                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                                              | Liveness; returns version and pid.                                                                                                                                                                                    |
| `POST /v1/sessions`                                           | SessionStart upsert → `{ session, agent? }` (the agent if the session already maps to one).                                                                                                                           |
| `GET /v1/sessions/{session_id}/pending`                       | Hook: pending deliveries (with the re-surface rule always applied) and open expectations for the session's agent; marks them `notified`/`hook`. Returns empty lists when the session has no agent.                    |
| `GET /v1/sessions/{session_id}/open`                          | Stop hook: `{ agent: { name, kind } \| null, open_replies: [...] }`. Read-only; never changes delivery state.                                                                                                         |
| `POST /v1/sessions/{session_id}/end`                          | SessionEnd: marks the session's agent offline.                                                                                                                                                                        |
| `POST /v1/agents`                                             | Register → `{ agent, token, peers }`. Reclaims the existing agent when `session_id` already maps to one (§5); upserts the `session` row. Profile updates go through this same call; there is no separate PATCH in v1. |
| `DELETE /v1/agents/{id}`                                      | Unregister (offline).                                                                                                                                                                                                 |
| `GET /v1/workspaces/{ws}/agents`                              | Peers (online). Caller must belong to the workspace.                                                                                                                                                                  |
| `POST /v1/messages`                                           | Send / reply.                                                                                                                                                                                                         |
| `GET /v1/agents/{id}/inbox`                                   | Inbox; marks `read`.                                                                                                                                                                                                  |
| `GET /v1/agents/{id}/conversations`                           | List with unread and open-expectation summaries.                                                                                                                                                                      |
| `GET /v1/conversations/{id}`                                  | Thread; caller must be a participant.                                                                                                                                                                                 |
| `GET /v1/agents/{id}/await?conversation=&message=&timeout_s=` | Long poll, ≤ 25 s per request.                                                                                                                                                                                        |
| `GET /v1/agents/{id}/events`                                  | SSE stream.                                                                                                                                                                                                           |
| `POST /v1/deliveries/{message_id}/{agent_id}`                 | Delivery state transition.                                                                                                                                                                                            |

### 8.1 Hub lifecycle

The edge, on start, reads `$XDG_DATA_HOME/agent-link/hub.json` `{ url, pid }` or the configured
hub URL and calls `/v1/health`. If that fails and the URL is a loopback address, it spawns
`agent-linkd` detached (stdio to a log file under the data dir), guarded by a lock file, and
waits up to 5 s for health. The hub writes `hub.json` on start. The hub keeps running after the
last edge disconnects; it is cheap and the store is durable.

## 9. Error handling

| Situation                                                      | Behaviour                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub unreachable from a tool                                    | `{ error: "hub_unavailable", hint }`; the edge attempts one spawn before giving up.                                                               |
| `register` without `session_id`                                | `{ error: "session_required", hint: "the SessionStart hook printed your session id" }`.                                                           |
| Any other tool before `register` (or after the edge restarted) | `{ error: "not_registered", hint: "call register with your session id" }`.                                                                        |
| Name collision                                                 | Suffix appended; returned name is authoritative; the agent is told.                                                                               |
| Recipient named in `to` offline between `peers` and `send`     | `{ error: "peer_not_found", online: [...] }`; the message is not created.                                                                         |
| Partial recipient failure in a multi-recipient `to`            | The whole send fails; nothing is written.                                                                                                         |
| Existing participant offline when a reply is sent              | The reply is written and delivered to online participants; the offline ones appear in `offline` with a `queued` delivery row for the record (§4). |
| Resumed session, edge restarted                                | SessionStart tells the agent to `register` again; the hub reclaims the row by `session_id`, so the name is kept and no `-2` suffix appears.       |
| Reply never comes                                              | No hub timeout. `await` times out and says so; `conversations` shows it still open; the Stop hook nags the other side once per stop.              |
| SSE drop                                                       | Reconnect with `Last-Event-ID`; messages queued meanwhile are replayed.                                                                           |
| Edge process dies with the session                             | Hub marks the agent offline after the 30 s grace. Undelivered messages stay `queued` in history for the record.                                   |
| Message body empty or over 64 KiB                              | `invalid_message`.                                                                                                                                |

## 10. Testing

- **Hub**: unit tests on the store (visibility, name uniqueness, delivery transitions, open
  expectations) and HTTP tests against an in-process hub on an ephemeral port, including SSE
  resume and long-poll timing. Node's built-in test runner (`node --test`) with TypeScript via
  `tsx`.
- **Edge**: tests drive the edge through the MCP SDK `Client` over an in-memory transport,
  against an in-process hub, asserting tool results and that a channel notification is emitted
  for an inbound message. Hook subcommands tested by feeding hook JSON on stdin.
- **End to end**: a script starts a hub and two edges as MCP clients, registers `architect` and
  `designer` in one workspace and `stranger` in another, and checks visibility, send/await,
  broadcast, reply marking, and offline handling.
- **Manual**: two Claude Code windows with the plugin loaded as a development channel, plus a
  third running `/agent-link:human`.

Coverage target 90% on hub and edge, per the code-quality conventions.

## 11. Decisions

- **D1** Architecture B: per-session stdio edge + shared local hub.
- **D2** Conversations are the primitive; no request-kind verbs; expectation is the only typed
  field.
- **D3** Edge uses `@modelcontextprotocol/sdk` 1.x and must not be upgraded to 2.x serving entry
  points: Claude Code refuses to register a channel on the 2026-07-28 protocol revision.
  FastMCP (TS and Python) rejected: TS cannot declare experimental capabilities; Python has no
  public custom-notification API and negotiates the new revision.
- **D4** Ephemeral identity, durable history, send-to-offline fails.
- **D5** Human participation is a relay session, one per workspace, not a CLI.
- **D6** The plugin is installed at user scope; `.agent-link.json` is the per-location switch.
  Hub state never decides whether a location is enabled or which workspace it uses.
- **D7** The edge registers the window provisionally at load; the model infers its identity
  from the session and asks the user for a name only when it cannot. The window owns the agent
  across session switches.
- **D8** Within a workspace the name is the identity: an identified registration adopts the
  offline agent of the same name (id, conversations, unread deliveries), absorbing the window's
  placeholder. `register` upgrades the edge's own agent by id and token. The edge detects the
  missing channels flag from the `claude` command line and degrades to hook delivery honestly
  instead of acking channel notifications Claude Code drops.

## 12. Repository layout

```
agent-link/
  package.json              pnpm workspaces, scripts: build, test, lint, typecheck, link:bins
  .claude-plugin/marketplace.json   local marketplace listing ./plugin
  packages/protocol/        shared types + zod schemas
  packages/hub/             agent-linkd: server, store, routes, sse, bin
  packages/edge/            agent-link-edge: mcp server, hub client, channel, hook, bin
  plugin/                   .claude-plugin/plugin.json, .mcp.json, hooks/, skills/agent-link, commands/{join,human}.md
  docs/history/specs/       this document
  .agent-link.json          { "workspace": "agent-link" } — this repo dogfoods itself
```
