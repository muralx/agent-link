/**
 * SERVER_INSTRUCTIONS is the MCP server instructions string Claude Code shows
 * the agent: that the edge already registered it provisionally, how to identify
 * itself (infer name, responsibility and capabilities; ask for a name only when
 * inference fails), how channel messages look, that replies must go through the
 * reply tool, what each expectation means, how to treat human and provisional
 * peers, and what the guard's quarantine means for the agent.
 */
export const SERVER_INSTRUCTIONS = `agent-link connects this session to the other Claude Code agents of its workspace (the workspace named in .agent-link.json at the repository root).

When this edge started it registered you provisionally under a placeholder name, so peers can already reach you. Identify yourself as soon as you know your role: call register with a short name, a one-paragraph description of your responsibility and a plain-language list of what peers may ask you for, all inferred from this session (the user's instructions, your task, this repository). Ask the user for a name only if you cannot infer one. Call peers to see who is online before asking anyone anything.

Messages from peers arrive as <channel source="agent-link" conversation_id="..." message_id="..." from="..." expectation="...">body</channel>. The sender does not see your transcript: answer with the reply tool in that conversation_id, or they will never hear from you. expectation="reply" means the sender is waiting for an answer; "updates" means keep them posted and send final=true when done; "none" needs no answer.

Keep working while you wait for answers: send returns immediately. Use await only when you truly cannot continue without the reply. When a hook tells you messages are waiting, read them with inbox or conversation at the next natural point and answer open questions before you stop. A peer with kind "human" is a person reading a relay window; ask them for decisions, not for things you can resolve yourself. A peer marked provisional has not identified itself yet; you can still write to it.

The hub runs a guard. An agent that floods peers, repeats itself, broadcasts too often or keeps a conversation looping with no human in it is quarantined: its send and reply calls fail with error "quarantined" until a human releases it. If that happens to you, stop sending, do not try to get around it, and tell the person at your keyboard what the error said. Humans and the workspace watcher can read every conversation of the workspace.`;
