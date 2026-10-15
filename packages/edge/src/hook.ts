import type { Env } from '@agent-link/hub';
import type { Message, OpenExpectation, SessionUpsertResponse } from '@agent-link/protocol';
import { resolveWorkspace } from './config.ts';
import type { HubClient } from './hub-client.ts';

/** HookEvent names the hook subcommands of agent-link-edge. */
export type HookEvent = 'session-start' | 'pending' | 'stop' | 'session-end';

/** HookInput is the subset of Claude Code's hook stdin JSON the hooks read. */
export interface HookInput {
  session_id?: string | undefined;
  cwd?: string | undefined;
  hook_event_name?: string | undefined;
  source?: string | undefined;
  tool_name?: string | undefined;
  stop_hook_active?: boolean | undefined;
}

/** HookResult is what a hook prints and its exit code. */
export interface HookResult {
  stdout: string;
  exitCode: number;
}

/**
 * HookDeps injects the hub client, the Claude Code window id and channel state
 * when known and, for tests, cwd, env and the per-call timeout.
 */
export interface HookDeps {
  client: HubClient;
  cwd?: string | undefined;
  env?: Env | undefined;
  /**
   * window is the Claude Code window id of the process the hook runs in, passed
   * to the hub so it can follow the window's agent across session switches.
   */
  window?: string | undefined;
  /**
   * channel is false when the window was started without the channels flag for
   * agent-link (channelEnabled), which SessionStart warns about; true or
   * undefined otherwise.
   */
  channel?: boolean | undefined;
  timeoutMs?: number | undefined;
}

/**
 * CHANNEL_WARNING is the SessionStart line for a window started without the
 * channels flag: peers' messages then arrive only through hooks.
 */
export const CHANNEL_WARNING =
  'Warning: this window was started without --dangerously-load-development-channels plugin:agent-link@agent-link, so messages from peers reach you only at your next prompt or tool call, never while you are idle. If this window must react to peers on its own (a human relay must), tell the user to quit and restart Claude Code with that flag.';

/**
 * HOOK_TIMEOUT_MS bounds each hub call made by a hook (1.5 s) so hooks never
 * stall the session.
 */
export const HOOK_TIMEOUT_MS = 1500;
/** EXCERPT_CHARS is the length of a message excerpt in hook text (200). */
export const EXCERPT_CHARS = 200;

/** SILENT is the hook result that prints nothing and succeeds. */
const SILENT: HookResult = { stdout: '', exitCode: 0 };

/**
 * enabled reports whether agent-link is switched on where the hook runs: a
 * workspace resolves from the hook's cwd (an .agent-link.json marker above it
 * or AGENT_LINK_WORKSPACE). Hooks in other locations do nothing, not even a
 * network call.
 */
function enabled(input: HookInput, deps: HookDeps): boolean {
  const cwd = input.cwd ?? deps.cwd ?? process.cwd();
  return resolveWorkspace(cwd, deps.env ?? process.env) !== undefined;
}

/** withTimeout rejects a promise that has not settled after ms milliseconds. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hook call timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * context builds the hookSpecificOutput JSON that injects additionalContext for
 * the named hook event.
 */
function context(eventName: string, text: string): HookResult {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
    }),
    exitCode: 0,
  };
}

/**
 * isAgentLinkTool reports whether a hook's tool_name belongs to the agent-link
 * MCP server (contains agent-link or agent_link in any case), so reading the
 * inbox never triggers a nag.
 */
export function isAgentLinkTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return lower.includes('agent-link') || lower.includes('agent_link');
}

/**
 * excerpt flattens whitespace and truncates a body to EXCERPT_CHARS with an
 * ellipsis.
 */
function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

/**
 * describePending renders the hook text for waiting messages: a count, one line
 * per message (from, expectation, conversation, 200-char excerpt) and what to
 * do.
 */
export function describePending(messages: Message[]): string {
  const lines = messages.map(
    (m) => `- ${m.from} (${m.expectation}) in ${m.conversation_id}: ${excerpt(m.body)}`,
  );
  const n = messages.length;
  return [
    `agent-link: ${n} message${n === 1 ? '' : 's'} waiting for you.`,
    ...lines,
    'Read them with the inbox or conversation tool at the next natural point, and answer anything that expects a reply with the reply tool.',
  ].join('\n');
}

/**
 * describeOpen renders the Stop hook's block reason: who is waiting, in which
 * conversation, since when, and that reply must be used.
 */
export function describeOpen(open: OpenExpectation[]): string {
  const n = open.length;
  const lines = open.map(
    (o) => `- ${o.from} in conversation ${o.conversation_id} (asked ${o.created_at})`,
  );
  return [
    `agent-link: ${n} peer${n === 1 ? ' is' : 's are'} waiting for your reply.`,
    ...lines,
    'Read each conversation with the conversation tool and answer with reply before stopping. If you truly cannot answer, reply saying so.',
  ].join('\n');
}

/**
 * sessionStart handles the SessionStart event (see runHook): silent without a
 * session id or outside an enabled location. Otherwise it upserts the session
 * (cwd, workspace hint, window, source) within timeoutMs and prints context
 * naming the workspace and session id, the window's agent state (provisional
 * placeholder to identify, identified agent to carry on as, or the generic hint
 * when the hub did not answer), the agent this conversation previously ran as
 * when that differs, and CHANNEL_WARNING when deps.channel is false.
 */
async function sessionStart(
  input: HookInput,
  deps: HookDeps,
  timeoutMs: number,
): Promise<HookResult> {
  const sessionId = input.session_id;
  if (!sessionId) return SILENT;
  const cwd = input.cwd ?? deps.cwd ?? process.cwd();
  const workspace = resolveWorkspace(cwd, deps.env ?? process.env);
  if (!workspace) return SILENT;
  let res: SessionUpsertResponse | undefined;
  try {
    res = await withTimeout(
      deps.client.sessionUpsert({
        session_id: sessionId,
        cwd,
        workspace_hint: workspace,
        ...(deps.window ? { window: deps.window } : {}),
        ...(input.source ? { source: input.source } : {}),
      }),
      timeoutMs,
    );
  } catch {
    // the hub may not be running yet; the edge starts it and registers
  }
  const lines: string[] = [
    `agent-link: other Claude Code agents in workspace "${workspace}" can talk to you, and you to them. Your session id is "${sessionId}". Use the agent-link skill.`,
  ];
  const agent = res?.agent;
  if (agent?.provisional) {
    lines.push(
      `This window is registered provisionally as "${agent.name}" (a placeholder). Identify yourself as soon as you know your role: infer a short name, what you are responsible for and what peers may ask you for from this session (the user's instructions, your task, this repository); ask the user for a name only if you cannot infer one. Then call register with them. Peers can already send you messages; answer them after identifying.`,
    );
  } else if (agent) {
    lines.push(
      `This window is registered as "${agent.name}" (${agent.kind}): ${agent.description} If this session is still about that, carry on as ${agent.name}; if it is about something else, call register with your new name, responsibility and capabilities.`,
    );
  } else {
    lines.push(
      'The edge registers this window provisionally when it starts. Identify yourself with the register tool once you know your role: name, responsibility and capabilities inferred from this session, asking the user for a name only if you cannot infer one.',
    );
  }
  if (res?.previous && res.previous.id !== agent?.id) {
    lines.push(
      `This conversation previously ran as "${res.previous.name}" (${res.previous.description}). If you are continuing that work, register under that name again.`,
    );
  }
  if (deps.channel === false) lines.push(CHANNEL_WARNING);
  return context('SessionStart', lines.join('\n'));
}

/**
 * pending handles UserPromptSubmit and PostToolUse (see runHook): silent when
 * disabled here, when the tool call was agent-link's own, or when there is
 * nothing to say. At UserPromptSubmit it reminds a still provisional agent to
 * identify itself; at both events it lists the waiting messages the hub
 * returned (which the hub marked notified).
 */
async function pending(input: HookInput, deps: HookDeps, timeoutMs: number): Promise<HookResult> {
  if (!input.session_id || isAgentLinkTool(input.tool_name) || !enabled(input, deps)) return SILENT;
  const res = await withTimeout(
    deps.client.sessionPending(input.session_id, deps.window),
    timeoutMs,
  );
  const event = input.hook_event_name ?? 'PostToolUse';
  const parts: string[] = [];
  if (res.agent?.provisional && event === 'UserPromptSubmit') {
    parts.push(
      `agent-link: you are still registered provisionally as "${res.agent.name}". Identify yourself with register (name, responsibility, capabilities inferred from this session) when you can.`,
    );
  }
  if (res.messages.length > 0) parts.push(describePending(res.messages));
  if (parts.length === 0) return SILENT;
  return context(event, parts.join('\n'));
}

/**
 * stop handles the Stop event through the read-only /open route (see runHook);
 * silent when disabled here, when stop_hook_active is set, for a human relay,
 * or when nothing is open.
 */
async function stop(input: HookInput, deps: HookDeps, timeoutMs: number): Promise<HookResult> {
  if (!input.session_id || input.stop_hook_active || !enabled(input, deps)) return SILENT;
  const res = await withTimeout(deps.client.sessionOpen(input.session_id, deps.window), timeoutMs);
  if (!res.agent || res.agent.kind === 'human' || res.open_replies.length === 0) return SILENT;
  return {
    stdout: JSON.stringify({ decision: 'block', reason: describeOpen(res.open_replies) }),
    exitCode: 0,
  };
}

/**
 * sessionEnd handles the SessionEnd event (see runHook): when enabled here it
 * tells the hub, which takes the agent offline unless its edge still holds a
 * stream.
 */
async function sessionEnd(
  input: HookInput,
  deps: HookDeps,
  timeoutMs: number,
): Promise<HookResult> {
  if (!input.session_id || !enabled(input, deps)) return SILENT;
  await withTimeout(deps.client.sessionEnd(input.session_id, deps.window), timeoutMs);
  return SILENT;
}

/**
 * runHook implements the plugin's hook commands against the hub and never fails
 * the hook: any error, timeout (HOOK_TIMEOUT_MS) or unknown event yields empty
 * stdout and exit 0. session-start upserts the session and prints SessionStart
 * context with the session id, workspace and register instructions (or a
 * reclaim hint when the session already has an agent); pending surfaces waiting
 * messages as additionalContext for the event named in the input, skipping
 * agent-link's own tool calls; stop blocks once with the open reply
 * expectations unless stop_hook_active is set or the agent is a human;
 * session-end takes the agent offline.
 */
export async function runHook(
  event: string,
  input: HookInput,
  deps: HookDeps,
): Promise<HookResult> {
  const timeoutMs = deps.timeoutMs ?? HOOK_TIMEOUT_MS;
  try {
    switch (event) {
      case 'session-start':
        return await sessionStart(input, deps, timeoutMs);
      case 'pending':
        return await pending(input, deps, timeoutMs);
      case 'stop':
        return await stop(input, deps, timeoutMs);
      case 'session-end':
        return await sessionEnd(input, deps, timeoutMs);
      default:
        return SILENT;
    }
  } catch {
    return SILENT;
  }
}
