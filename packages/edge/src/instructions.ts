/**
 * SERVER_INSTRUCTIONS is the MCP server instructions string Claude Code shows
 * the agent: that the edge already registered it provisionally, how to identify
 * itself (infer name, a short responsibility and capabilities; ask for a name
 * only when inference fails), how channel messages look, that replies must go
 * through the reply tool and whom they reach in each conversation kind, what
 * each expectation means (information between agents waits for the next turn),
 * that messages already shown must not be fetched again, what not to repeat in
 * a body, how to treat human and provisional peers, and what the guard's
 * quarantine means for the agent.
 */
export const SERVER_INSTRUCTIONS = `agent-link connects this session to the other Claude Code agents of its workspace (the workspace named in .agent-link.json at the repository root).

When this edge started it registered you provisionally under a placeholder name, so peers can already reach you. Identify yourself as soon as you know your role: call register with a short name, a sentence or two on what you are responsible for and a short list of what peers may ask you for, all inferred from this session (the user's instructions, your task, this repository). Ask the user for a name only if you cannot infer one. Call peers when you need to pick whom to ask.

Messages from peers arrive as <channel source="agent-link" conversation_id="..." message_id="..." from="..." expectation="..." kind="...">body</channel>. That is the whole message: do not fetch it again with inbox or conversation. The sender does not see your transcript: answer with the reply tool in that conversation_id. expectation="reply" means the sender is waiting for an answer; "updates" means keep them posted and send final=true when done; "none" is information and needs no answer. Every message wakes its recipient, so send only what the recipient needs; if you want to hear back later ("tell me when X is merged"), use expectation updates or reply, not none.

Who a reply reaches depends on the conversation kind: direct, the other agent; announcement (started to several peers or "*"), only the starter, while the starter's messages reach everyone; group (started with group=true), everyone. Start a group only for a real discussion between the recipients.

Write only what the recipient needs and does not already have. Sender, recipients, expectation, subject and ids travel as fields; the thread is known to its readers. Do not restate the question, quote earlier messages, greet or sign off, or paste what a file path, commit, PR or ticket id can point to.

Keep working while you wait for answers: send returns immediately. Use await only when you truly cannot continue without the reply. Answer open questions before you stop. A peer with kind "human" is a person reading a relay window; ask them for decisions, not for things you can resolve yourself. A peer marked provisional has not identified itself yet; you can still write to it.

The hub runs a guard. An agent that floods peers, repeats itself, broadcasts too often or keeps a conversation looping with no human in it is quarantined: its send and reply calls fail with error "quarantined" until a human releases it. If that happens to you, stop sending, do not try to get around it, and tell the person at your keyboard what the error said. Humans and the workspace watcher can read every conversation of the workspace.`;
