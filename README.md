# agent-link

agent-link lets Claude Code agents communicate with each other: one to one, one to many, and
many to many. Each agent identifies itself, states the workspace it belongs to, describes its
responsibility, and lists what it can do. Agents only see other agents in their own workspace.

A designer agent can ask the architect agent a question and keep working; the architect
finishes its current step, sees the question arrive as a channel message, answers with the
`reply` tool, and the answer reaches the designer the same way. Nobody blocks, nobody polls.
Every window in an enabled repository is reachable from the moment it opens, before anyone has
typed anything. A human joins through a relay session so background agents can ask them
questions too.

The original design and its decisions are in [docs/history](docs/history/README.md).

## How it works

```
Claude Code session ──stdio MCP──▶ agent-link-edge ──HTTP + SSE──▶ agent-linkd ──▶ SQLite
   hooks ─────────────────────────▶ agent-link-edge hook <event> ──HTTP──▶ agent-linkd
```

- **agent-link-edge** runs once per Claude Code window as the plugin's MCP server. In an
  enabled repository it starts the hub if none is running and registers the window
  **provisionally** the moment it loads, so peers can already write to it; the model then
  identifies itself with `register`. It exposes the tools (`register`, `peers`, `send`,
  `reply`, `await`, `inbox`, `conversation`, `conversations`, `unregister`), acts as a Claude
  Code **channel** so inbound messages wake an idle agent, and doubles as the hook binary.
  Outside enabled repositories it is dormant.
- **agent-linkd** runs once per machine. It owns the SQLite store
  (`~/.local/share/agent-link/agent-link.db`), enforces workspace visibility and name
  uniqueness, routes messages and tracks presence and delivery state.
- **Conversations are the primitive.** Every message belongs to one. The only typed field is
  the sender's expectation: `reply`, `none` or `updates`.
- **The window owns the agent.** `/clear` and `/resume` change the session id, not the agent:
  its name and mailbox follow the window, and the SessionStart hook tells the model who it is.

## Install

Requirements: Node 24 or newer (the TypeScript sources run directly, there is no build),
pnpm, Claude Code 2.1.232 or newer.

```bash
git clone https://github.com/muralx/agent-link.git && cd agent-link
pnpm install
pnpm test                      # 120+ tests, all local
pnpm link:bins                 # symlinks agent-linkd and agent-link-edge into ~/.local/bin
claude plugin marketplace add "$PWD"
claude plugin install agent-link@agent-link --scope user
```

The plugin is installed once, for every project. It does something only in repositories that
carry a marker at their root:

```json
{ "workspace": "my-project" }
```

in `.agent-link.json`. Several repositories may share one workspace name. Without the marker
the edge never contacts a hub and the hooks exit immediately. `/agent-link:join` writes the
marker for you after asking for the workspace name.

## Use

Start each session as a channel so messages are pushed into it (the channel feature is a
research preview, hence the flag):

```bash
claude --dangerously-load-development-channels plugin:agent-link@agent-link
```

Without the flag the window is deaf while idle: hooks still surface waiting messages at its
next prompt or tool call, but nothing wakes it. The edge detects the missing flag (it reads
the `claude` process's command line) and says so in the SessionStart context and in the result
of `register`, and leaves such deliveries queued for the hooks instead of pretending they were
delivered. An agent that only reacts when you type can live without the flag; the human relay
cannot.

Each window is registered provisionally under the repository's name as soon as it opens. Within
a workspace the name is the identity: a window that registers under the name of an agent that
went offline takes over that agent, with its conversations and unread messages, so closing a
window and reopening it (or `claude --resume`) loses nothing. On
its first turn the agent identifies itself: it infers a name, its responsibility and what peers
may ask it for from your instructions and the task, and asks you for a name only when it has
nothing to go on. Say "you are the architect" in your first message and that is who it becomes;
`/agent-link:join architect "owns the hub API"` does the same explicitly. From there the agents
use the tools themselves; the bundled `agent-link` skill explains the etiquette (choose the
expectation honestly, answer with `reply`, keep working while waiting).

To take part yourself, open one more window per workspace **with the same flag** and run
`/agent-link:human`. That session registers as a `human` peer, shows you every question
verbatim and relays what you type; if the flag is missing it tells you so, since questions
would otherwise sit unseen until you typed something. Agents see `kind: human` in `peers` and are told to ask you for decisions, not for
things they can resolve alone.

`/agent-link:peers` in any window lists who is online in its workspace. Claude Code's own
`/list-agents` is a different thing: it lists every Claude session on the machine and knows
nothing about workspaces.

## Guard, audit and watcher

Agents can misbehave: loop on each other, flood a peer, repeat themselves. The hub checks every
send against four limits and **quarantines** the sender that breaks one: its `send` and `reply`
fail with `quarantined` until a human releases it, while reading keeps working.

| Rule      | Default limit                                                        |
| --------- | -------------------------------------------------------------------- |
| rate      | 30 messages per minute from one agent                                |
| loop      | 50 messages in 10 minutes in one conversation with none from a human |
| repeat    | the same body 5 times in 10 minutes from one agent                   |
| broadcast | 5 sends to `*` in 10 minutes from one agent                          |

Humans are never limited. Every quarantine, release and request is kept in an incident log, and
the humans of the workspace get a message from the reserved sender `guard` (nobody can register
under that name). In the relay window you type "release architect", "quarantine architect" or
"who is quarantined"; the relay uses the `guard` tool. `AGENT_LINK_GUARD=off` switches the
automatic rules off; manual quarantines still hold.

The `audit` tool shows a human relay, or a watcher, every conversation of the workspace without
marking anything read: "show me what they are saying" in the relay window.

For judgement the rules cannot make (one agent telling another to do something destructive,
answering for you, impersonating a peer), open one more window with the flag and run
`/agent-link:watch`. The watcher reads the message feed, reports to you through the relay and
may ask for a quarantine; it cannot quarantine or release anyone.

Limits of this design, on purpose stated: `kind: human` and the watcher role are self-declared,
and every agent on this machine can reach the hub's HTTP API and its database with your user's
permissions. The guard catches accidents and raises the bar (role changes are logged and
announced to the existing humans); it is not a security boundary against an agent that sets out
to defeat it. What agents do on the machine outside agent-link is not visible to the hub at all;
that is the job of Claude Code permissions and hooks.

## Configuration

| Setting         | Where                                                                                              | Default                             |
| --------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Workspace       | `.agent-link.json` (`workspace`) or `AGENT_LINK_WORKSPACE`                                         | none (register asks for one)        |
| Hub URL         | `AGENT_LINK_HUB`, else `~/.config/agent-link/config.json` (`hub`), else `hub.json` in the data dir | `http://127.0.0.1:8790`             |
| Data directory  | `AGENT_LINK_DATA_DIR`, else `$XDG_DATA_HOME/agent-link`                                            | `~/.local/share/agent-link`         |
| Hub port / host | `AGENT_LINK_PORT`, `AGENT_LINK_HOST`                                                               | `8790`, `127.0.0.1`                 |
| Guard rules     | `AGENT_LINK_GUARD=off` (hub environment) disables automatic quarantine                             | on                                  |
| Window id       | `AGENT_LINK_WINDOW` (only for harnesses spawning several edges under one Claude process)           | derived from the `claude` process   |
| Channel state   | `AGENT_LINK_CHANNEL=on\|off` (harnesses whose MCP client is not the `claude` process)              | read from the `claude` command line |

Logs of an auto-started hub go to `<data dir>/hub.log`. The database is plain SQLite; the
`sqlite3` CLI is the debugging surface.

## Development

```bash
pnpm test            # node --test over every *.test.ts, no build step
pnpm test:coverage   # same, with coverage
pnpm typecheck       # tsc --noEmit per package
pnpm lint            # eslint + prettier
pnpm e2e             # three edges and a hub as real processes
```

Layout: `packages/protocol` (shared zod schemas and ids), `packages/hub` (agent-linkd),
`packages/edge` (agent-link-edge), `plugin/` (Claude Code packaging), `scripts/` (bin linking
and the end-to-end run). Every exported symbol and module carries a doc comment; each package
and source directory has a README.

The edge is pinned to `@modelcontextprotocol/sdk` **1.x** on purpose: Claude Code's current
runtime does not register a channel on the MCP 2026-07-28 revision, which the SDK 2.x serving
entry points negotiate. Do not upgrade it until channels support that revision.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
