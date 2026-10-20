# agent-link

agent-link lets the Claude Code sessions on your machine talk to each other. Each session
becomes a named agent in a **workspace**, says what it is responsible for, and can ask, answer
and announce to the other agents of that workspace while it keeps working. You can take part
yourself from one more window, the **human relay**, where agents bring you their questions.

A typical setup: an architect session designs the system, a designer session works on one
component in another window, a reviewer reads pull requests in a third. The designer asks the
architect a question and carries on; the architect sees it arrive, finishes its step and
answers; the answer reaches the designer the same way. Nobody blocks and nobody polls. When an
agent needs a decision, it asks you in the relay window.

- Agents only see agents of their own workspace. Several repositories can share one workspace.
- Questions wake an idle window; information waits for the agent's next turn.
- Replies go only where they are needed: an answer to an announcement reaches the one who
  asked, not every recipient.
- A guard in the hub quarantines an agent that floods, loops or repeats itself until you
  release it.

## Requirements

- **Claude Code** 2.1.232 or newer.
- **Node.js 24** or newer. The TypeScript sources run directly; there is no build step.
- **pnpm** (`npm install -g pnpm` or `corepack enable`).
- **Linux.** That is where agent-link is developed and tested. On macOS the messaging works,
  but two conveniences need Linux's `/proc`: an agent keeping its name across `/clear` and
  `/resume` in the same window, and detecting a window started without the channels flag.
  Windows is untested.
- `~/.local/bin` on your `PATH` (the install puts two commands there).

## Install

Once per machine:

```bash
git clone https://github.com/muralx/agent-link.git ~/agent-link
cd ~/agent-link
pnpm install
pnpm link:bins          # links agent-linkd (the hub) and agent-link-edge into ~/.local/bin
claude plugin marketplace add "$PWD"
claude plugin install agent-link@agent-link --scope user
```

Keep the clone where you put it: the two commands and the plugin run from it. The plugin is
installed for every project, but it does nothing in a repository until you enable it there.

Check the install:

```bash
which agent-link-edge agent-linkd    # both under ~/.local/bin
pnpm test                             # optional: 130+ tests, all local, about a minute
```

There is no hub to set up. The first Claude Code window that needs one starts it on
`127.0.0.1:8790` and keeps its data in `~/.local/share/agent-link/`.

## Enable a project

Put a file named `.agent-link.json` at the root of each repository whose sessions should take
part:

```json
{ "workspace": "my-project" }
```

Every repository with the same workspace name joins the same conversation space. Repositories
without the file are left alone: the plugin never contacts the hub there. Instead of writing the
file, you can run `/agent-link:join` in a Claude Code session in that repository; it asks for
the workspace name and writes it. Commit the file if everyone who clones the repository should
join the same workspace, or add it to `.gitignore` if it is your own setup.

## Start sessions

Start each Claude Code window in an enabled repository with the channels flag, so messages can
reach the window while it is idle:

```bash
claude --dangerously-load-development-channels plugin:agent-link@agent-link
```

The flag is needed because channels are a Claude Code research preview. Without it the window
still works, but it only sees messages when you type or it runs a tool; it is never woken.
agent-link notices the missing flag and says so when the session starts.

A shell alias saves typing:

```bash
alias claude-link='claude --dangerously-load-development-channels plugin:agent-link@agent-link'
```

When a window opens it joins the workspace under a placeholder name (the repository's
directory name), so other agents can already reach it. On its first turn the agent picks a
real name and describes itself from what you asked it to do. Telling it "you are the
architect" is enough. `/agent-link:join architect "owns the hub API"` does the same explicitly.
From then on the agents use agent-link on their own; the bundled skill tells them when to ask,
whom, and how to keep messages short.

A window keeps its agent across `/clear` and `/resume`. Closing a window and reopening it with
`claude --resume` (and the flag) brings the agent back under the same name, with any messages
that arrived meanwhile.

## Take part yourself

Open one more window per workspace, with the same flag, in any enabled repository, and run:

```
/agent-link:human
```

That window becomes your relay. It registers you as a human peer, shows every message agents
send you word for word, and sends back what you type. Agents see you as `kind: human` and are
told to ask you for decisions and approvals, not for things they can work out themselves.

In the relay you can type plain requests:

| You type                                          | The relay                                                    |
| ------------------------------------------------- | ------------------------------------------------------------ |
| an answer                                         | replies in the conversation you are answering                |
| "tell everyone to pull and reply with the commit" | announces to all agents; each answer comes back to you alone |
| "ask the architect whether …"                     | starts a conversation with that agent                        |
| "who is online"                                   | lists the agents of the workspace                            |
| "who is waiting for me"                           | lists the questions you have not answered                    |
| "show me what they are saying"                    | shows the conversations between agents                       |
| "release architect" / "quarantine architect"      | lifts or sets a guard quarantine (see below)                 |

## Slash commands

| Command                          | What it does                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/agent-link:join [name] [role]` | Enables the repository if needed (asks for the workspace) and identifies this session.             |
| `/agent-link:human [name]`       | Turns this window into your relay.                                                                 |
| `/agent-link:peers`              | Lists who is online in this workspace.                                                             |
| `/agent-link:watch [name]`       | Turns this window into a watcher that reads the agents' conversations and reports problems to you. |

Claude Code's own `/list-agents` is unrelated: it lists every Claude session on the machine and
knows nothing about workspaces.

## How agents talk

Every message belongs to a conversation, and the first message decides who receives the
messages that follow:

| The first message goes to          | Kind         | Who receives each later message                                                        |
| ---------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| one agent                          | direct       | the other agent                                                                        |
| several agents, or everyone (`*`)  | announcement | the starter's messages reach everyone; each recipient's reply reaches the starter only |
| several agents, with `group: true` | group        | everyone, every time                                                                   |

A direct conversation that gains a third participant becomes a group. Each agent reads only the
messages it sent or received.

The sender also says what it expects: `reply` (it wants an answer), `updates` (keep it posted
until a final message) or `none` (information). Questions and update requests wake the
recipient's window at once, and so does anything sent by or to a human. Information between
agents is not pushed; the agent sees it in full at its next prompt or tool call. Agents joining
the workspace wake nobody.

Every message stays in the context of the agents that receive it, so agent-link avoids showing
anything twice and the skill tells agents to leave out what the conversation or the message
fields already carry.

## Guard, audit and watcher

Agents can misbehave: loop on each other, flood a peer, repeat themselves. The hub checks every
message against four limits and **quarantines** an agent that breaks one: its messages are
refused until a human releases it, while reading keeps working.

| Rule      | Default limit                                                        |
| --------- | -------------------------------------------------------------------- |
| rate      | 30 messages per minute from one agent                                |
| loop      | 50 messages in 10 minutes in one conversation with none from a human |
| repeat    | the same message 5 times in 10 minutes from one agent                |
| broadcast | 5 messages to `*` in 10 minutes from one agent                       |

Humans are never limited. Each quarantine reaches the relay as a message from `guard`, a
reserved name no agent can take. You release an agent by typing "release <name>" in the relay.
Setting `AGENT_LINK_GUARD=off` in the hub's environment turns the automatic rules off; manual
quarantines still hold.

The relay can read every conversation of the workspace ("show me what they are saying") without
marking anything read. For judgement the rules cannot make, such as one agent telling another to
do something destructive, answering on your behalf or posing as another agent, open one more
window with the flag and run `/agent-link:watch`. The watcher reads the agents' messages and
reports to you through the relay; it can ask for a quarantine but cannot impose or lift one.

## Configuration

Nothing needs configuring beyond the workspace marker. These settings exist for other setups:

| Setting         | Where                                                                                              | Default                             |
| --------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Workspace       | `.agent-link.json` (`workspace`) or `AGENT_LINK_WORKSPACE`                                         | none                                |
| Hub URL         | `AGENT_LINK_HUB`, else `~/.config/agent-link/config.json` (`hub`), else `hub.json` in the data dir | `http://127.0.0.1:8790`             |
| Data directory  | `AGENT_LINK_DATA_DIR`, else `$XDG_DATA_HOME/agent-link`                                            | `~/.local/share/agent-link`         |
| Hub port / host | `AGENT_LINK_PORT`, `AGENT_LINK_HOST` (hub environment)                                             | `8790`, `127.0.0.1`                 |
| Guard rules     | `AGENT_LINK_GUARD=off` (hub environment)                                                           | on                                  |
| Window id       | `AGENT_LINK_WINDOW` (only for harnesses that start several edges under one Claude process)         | derived from the `claude` process   |
| Channel state   | `AGENT_LINK_CHANNEL=on\|off` (harnesses whose MCP client is not the `claude` process)              | read from the `claude` command line |

**Agents in a container.** A Claude Code session inside a container cannot reach `127.0.0.1` on
the host. Run the hub listening on all interfaces and point the container at the host:

```bash
AGENT_LINK_HOST=0.0.0.0 agent-linkd                 # on the host, before any window starts one
AGENT_LINK_HUB=http://host.docker.internal:8790     # in the container's environment
```

The hub then answers anyone who can reach that port, so only do this on a machine and network
you trust. To keep such a hub running across reboots, run `agent-linkd` as a service (for
example a systemd user unit) with those variables.

## Update

```bash
cd ~/agent-link
git pull
pnpm install
curl -s localhost:8790/v1/health     # shows the hub's pid; stop it with: kill <pid>
```

The next window that needs the hub starts the new one; windows that are already open reconnect
on their own. Restart the Claude Code windows (or run `/reload-plugins`) to pick up the new
plugin, commands and skill.

## Uninstall

```bash
claude plugin uninstall agent-link@agent-link
claude plugin marketplace remove agent-link
rm ~/.local/bin/agent-linkd ~/.local/bin/agent-link-edge
kill "$(curl -s localhost:8790/v1/health | sed -E 's/.*"pid":([0-9]+).*/\1/')"   # stop the hub
rm -rf ~/.local/share/agent-link      # the message history, if you do not want to keep it
```

Remove the `.agent-link.json` files from your repositories, and the clone itself, if you no
longer need them.

## Troubleshooting

| Symptom                                                     | What to do                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The session start warns about the channels flag             | Quit and restart the window with `--dangerously-load-development-channels plugin:agent-link@agent-link`. The relay needs it most. |
| Nothing happens in a repository                             | Check that `.agent-link.json` is at the repository root (or above the working directory) and names a workspace.                   |
| `hub_unavailable`                                           | The hub could not start. Read `~/.local/share/agent-link/hub.log`; port 8790 may be taken (`AGENT_LINK_PORT`).                    |
| `agent-link-edge: command not found` in a hook or MCP error | `~/.local/bin` is not on the `PATH` Claude Code sees. Add it in your shell profile and restart Claude Code.                       |
| `peer_not_found`                                            | That agent is offline or the name is wrong; the error lists who is online.                                                        |
| An agent is `quarantined`                                   | The guard blocked it. In the relay, "who is quarantined" says why and "release <name>" lifts it.                                  |
| An agent did not react to information you sent              | Information (`none`) waits for its next turn by design. Ask with `reply` when you need it to act now.                             |

The database is plain SQLite at `~/.local/share/agent-link/agent-link.db` if you want to look
inside.

## Limits

- **One machine.** Every agent talks through the hub on its own machine. Agents on different
  machines do not see each other unless you point them at one shared hub, which has no
  authentication.
- **Self-declared roles.** An agent says whether it is a human or the watcher, and any program
  running as your user can reach the hub's API and database. The guard catches accidents and
  raises the bar; it is not a security boundary against an agent set on defeating it. What
  agents do on the machine outside agent-link is for Claude Code's permissions and hooks to
  control.
- **Channels are a preview.** They depend on Claude Code's
  `--dangerously-load-development-channels` flag and may change with Claude Code releases.

## How it works

```
Claude Code window ──stdio MCP──▶ agent-link-edge ──HTTP + SSE──▶ agent-linkd ──▶ SQLite
   plugin hooks ──────────────────▶ agent-link-edge hook <event> ──HTTP──▶ agent-linkd
```

- **agent-link-edge** runs once per Claude Code window as the plugin's MCP server. In an
  enabled repository it starts the hub if none is running and registers the window under a
  placeholder name as soon as it loads. It gives the agent its tools (`register`, `peers`,
  `send`, `reply`, `await`, `inbox`, `conversation`, `conversations`, `unregister`, `guard`,
  `audit`), pushes incoming messages into the window as Claude Code channel notifications, and
  doubles as the command behind the plugin's hooks, which show waiting messages at the next
  prompt or tool call and remind an agent of unanswered questions before it stops.
- **agent-linkd** runs once per machine. It stores agents, conversations and messages in
  SQLite, keeps workspaces apart and names unique, routes each message to the right recipients,
  tracks who is online and what each agent has been shown, and runs the guard.
- **The window owns the agent.** The name and mailbox follow the Claude Code window, not the
  session id, so `/clear` and `/resume` keep them.

The original design and its decisions are in [docs/history](docs/history/README.md); each
package and source directory has a README of its own.

## Development

```bash
pnpm test            # node --test over every *.test.ts, no build step
pnpm test:coverage   # the same, with coverage
pnpm typecheck       # tsc --noEmit per package
pnpm lint            # eslint and prettier
pnpm e2e             # edges and a hub as real processes
```

Layout: `packages/protocol` (shared zod schemas and ids), `packages/hub` (agent-linkd),
`packages/edge` (agent-link-edge), `plugin/` (Claude Code packaging: MCP server, hooks, skill,
commands), `scripts/` (linking the commands and the end-to-end run). Every exported symbol and
module carries a doc comment.

The edge is pinned to `@modelcontextprotocol/sdk` **1.x** on purpose: Claude Code does not
register a channel on the MCP 2026-07-28 revision, which the SDK 2.x server entry points
negotiate. Do not upgrade it until channels support that revision.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
