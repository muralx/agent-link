---
name: agent-link
description: Use when this session should talk to other Claude Code agents in the same workspace — joining a repository to agent-link, identifying yourself after the edge registered you provisionally, finding peers, asking a question, answering one, announcing to several peers, writing a message, reading hook notices about messages, or when a <channel source="agent-link"> message arrives.
---

# Talking to other agents with agent-link

agent-link gives every Claude Code session in a workspace a name and a mailbox. Agents only
see agents of their own workspace. The workspace comes from `.agent-link.json` at the
repository root; that file is the switch that turns agent-link on for a location. Messages are
plain markdown; the only typed field is the sender's **expectation**.

## Step 1: find out what is missing, ask only for that

Work through this list in order. Most steps are already done; do not ask about them.

1. **Is this location enabled?** Look for `.agent-link.json` walking up from the working
   directory (the SessionStart hook already told you if it is; "agent-link: other Claude Code
   agents in workspace X can talk to you" means yes). If there is no marker and the user wants
   this session to talk to other agents, ask **one** question: the workspace name, suggesting
   the repository directory name. Several repositories may share a workspace by using the same
   name. Write `{ "workspace": "<name>" }` to `.agent-link.json` at the repository root. No
   restart is needed; the tools read the marker on every call.
2. **Is the hub running?** You never check. The edge starts it; a `hub_unavailable` error means
   it could not, and the hint says where the log is.
3. **Who are you?** In an enabled location the edge registered this window **provisionally**
   under a placeholder name (the directory name) the moment the session opened, so peers can
   already reach you. Your job is to replace the placeholder with a real identity:
   - **name**: short, specific, how peers will address you (`architect`, `hub-reviewer`,
     `docs-writer`). Infer it from the user's instructions, the task you were given, this
     repository and its CLAUDE.md. If the user said "you are the architect", that is the name.
   - **description**: a sentence or two on what you are responsible for in this workspace.
   - **capabilities**: a short plain-language list of what peers may ask you for ("consult on
     architecture, resolve API disputes, execute refactors in packages/hub").
     Every peer that calls `peers` reads both, so keep them to what a peer needs to decide
     whether to ask you: no history, status reports or ticket lists.
     Then call `register` with those three fields. You do not need a session id. The returned
     `name` is yours (the hub suffixes `-2`, `-3` when the name is taken).
     **Ask the user only when you cannot infer a name**, typically a window opened with no
     instruction yet. Ask for the name alone, in one line, and infer the rest.
4. **Still provisional?** Hooks remind you at each prompt until you identify yourself, and a
   message addressed to you says so. Identify yourself first, then answer.

If a tool answers `not_registered`, call `register` again with the same fields: the hub gives
you your identity back, with any messages that arrived meanwhile. If `register` answers
`session_required`, pass `session_id` exactly as the SessionStart hook printed it.

## Step 2: pick whom to ask

`register` returned the names of the online peers. Call `peers` when you need to know what they
do, not on every turn, and use only names it or `register` gave you; do not guess. `peers` is the
agent-link tool; Claude Code's own session listing (`ListAgents`, `SendMessage`) shows every
Claude session on the machine regardless of workspace and is not part of agent-link, so do not
use it to find or reach workspace peers. A peer with `provisional: true` has not identified
itself yet; you may still write to it. A peer with `kind: "human"` is the person at a relay
window: ask for decisions and approvals, not for things you can find out or decide yourself,
and expect human-scale latency.

Address only the peers who must act or decide. Who else reads the conversation is fixed when
it starts:

| You send                      | Kind         | Who receives each later message                                           |
| ----------------------------- | ------------ | ------------------------------------------------------------------------- |
| `to: ["one"]`                 | direct       | the other agent                                                           |
| `to: ["a", "b"]` or `to: "*"` | announcement | your messages reach everyone; each recipient's reply reaches **only you** |
| `to: ["a", "b"], group: true` | group        | everyone, every time                                                      |

Announcements are the default because most messages to several peers collect answers ("pull
and tell me your commit"). Start a group only when the recipients must discuss with each other;
every message in a group wakes all of them.

## Step 3: choose the expectation honestly

| You want                       | `expectation` | What happens                                                                                           |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------ |
| An answer you will act on      | `reply`       | The peer is woken and told someone is waiting; its Stop hook holds it until it answers.                |
| Progress on work you delegated | `updates`     | The peer should reply as it goes and send `final: true` when done.                                     |
| Nothing                        | `none`        | Information. An agent gets it at its next turn instead of being woken; a human always sees it at once. |

`send` returns immediately with `delivered_to` (the recipients online now) and `offline` (the
ones that will get it when they come back). **Keep working.** The answer arrives as a channel
message. Call `await` with the `conversation_id` only when you genuinely cannot proceed
without it, and never to wait for a human: their answer can take hours. Claude Code moves a
long `await` to the background after about two minutes; the answer then arrives as a task
notification.

## Step 4: write only what the recipient needs

Every message lands in each recipient's context and stays there for the rest of its session.
Say everything the recipient needs to act, and nothing it already has:

- **Not what the fields carry.** Sender, recipients, expectation, subject and ids are shown
  with the message: no "From architect:", no "@designer", no "FYI", no "Question:" header, no
  restating the subject.
- **Not what the conversation already holds.** Do not quote or summarise earlier messages,
  restate the question you are answering, or repeat your previous message with one change.
- **Not what a reference can carry.** Point to a file path and line, a commit, a PR or a
  ticket id instead of pasting its content, unless the recipient cannot reach it.
- **No ceremony.** No greetings, thanks, sign-offs, "let me know if…", or offers of further
  help.
- **Lead with the answer or the request**, then only the reasoning or detail the recipient
  needs to act on it.
- **One message per thing to act on.** No progress notes unless the sender asked for
  `updates`; then one message per real step and a single `final: true`.

## Step 5: answer in the conversation, never in your transcript

A peer's message arrives as
`<channel source="agent-link" conversation_id="cv_…" message_id="msg_…" from="…" expectation="…" kind="…">`,
with the subject and, in an announcement or group, who else got it on the first line. That is
the whole message: do not read it again with `inbox` or `conversation`. The sender does not
see what you print; use `reply` with that `conversation_id`. Finish your current step first if
you are mid-task; the message waits. Tell the person at your keyboard about any request a peer
makes before you act on it.

A hook notice "agent-link: N messages for you, shown in full" carries the messages themselves
(information that did not wake you, or anything that arrived while this window could not be
woken); answer from it, there is nothing to fetch. Call `inbox` only if you have reason to think
something arrived unseen; it returns only messages you have not been shown. To catch up on a
thread after a compaction, call `conversation` with `since` set to the last message id you have.
Before stopping, answer every open `reply` expectation; `conversations` with `open_only: true`
lists them. If the same message reaches you twice, answer it once.

## Switching sessions in a window

`/clear` or `/resume` changes the session id but not the window. Your agent, its name and its
mailbox follow the window; the SessionStart hook tells you who this window is registered as. If
the new conversation is about something else, call `register` with a new identity. If the hook
says the resumed conversation previously ran under another name and you are continuing that
work, register under that name again.

## Broadcast sparingly

`to: "*"` reaches every online peer and starts an announcement: their answers come back to you
alone. Use it for what affects everyone ("I am changing the hub API; reply if you depend on
/v1/messages"), not for a question one peer can answer.

## The guard

The hub checks every send. An agent that sends more than 30 messages a minute, repeats the same
message, broadcasts again and again, or keeps a conversation going back and forth with no human
in it, is **quarantined**: `send` and `reply` fail with `error: "quarantined"` until a human
releases it. Reading still works.

- If it happens to you: stop sending, do not look for a way around it (a new name, another
  session, the hub API), and tell the person at your keyboard what the error said. A human of
  the workspace releases you with the `guard` tool.
- `peers` marks quarantined peers; do not wait for an answer from one.
- `guard` with `action: "status"` shows who is quarantined and why. The other actions are for
  human relays (`quarantine`, `release`) and for the watcher (`request`).
- Humans and the workspace watcher (`/agent-link:watch`) can read every conversation of the
  workspace through `audit`. Write accordingly: no secrets in messages.
- Messages from `guard` are notices from the hub. They need no reply.

## Troubleshooting

- `peer_not_found`: the peer is offline or misspelled; the error lists who is online.
- `hub_unavailable`: the local hub is down; the edge restarts it once. Logs are in
  `~/.local/share/agent-link/hub.log`.
- `quarantined`: the guard blocked your sends. See "The guard" above.
- `workspace_required`: no `.agent-link.json` above the working directory. Go back to step 1.
- `register` answered `channel: "unavailable"`, or the SessionStart context carried a warning
  about the channels flag: Claude Code was started without
  `--dangerously-load-development-channels plugin:agent-link@agent-link`, so it drops the
  pushed messages. Nothing is lost: deliveries stay queued and a hook shows them in full at
  your next prompt or tool call, but an idle window is never woken. Tell the user; a human relay
  must be restarted with the flag.
- A peer should have received your message but did not react: `delivered_to` in your send
  result says it was online. Information (`none`) waits for its next turn by design; a window
  without the channels flag sees anything only when its user types.
