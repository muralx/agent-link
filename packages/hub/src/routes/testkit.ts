import type { Message, SendResponse } from '@agent-link/protocol';
import { createHub, type Hub, type HubOptions } from '../server.ts';

/** TestAgent is a registered test agent's credentials. */
export interface TestAgent {
  id: string;
  name: string;
  token: string;
  session: string;
}

/** Frame is one parsed SSE frame. */
export interface Frame {
  id?: string;
  event?: string;
  data?: unknown;
  comment?: string;
}

/**
 * withHub runs fn against an in-process hub on an ephemeral port with an
 * in-memory database and always closes it; options pass through to createHub
 * (keepalive, grace, guard limits or guard: false). Test helper.
 */
export async function withHub(
  fn: (hub: Hub, base: string) => Promise<void>,
  options: Omit<HubOptions, 'dbPath' | 'port' | 'host'> = {},
): Promise<void> {
  const hub = createHub({ dbPath: ':memory:', port: 0, ...options });
  const base = await hub.listen();
  try {
    await fn(hub, base);
  } finally {
    await hub.close();
  }
}

/**
 * registerAgent registers a test agent named name (session s-name) in workspace
 * and returns its id, name, token and session id; extra overrides or adds body
 * fields such as kind or watcher.
 */
export async function registerAgent(
  base: string,
  name: string,
  workspace = 'w',
  extra: Record<string, unknown> = {},
): Promise<TestAgent> {
  const res = await fetch(`${base}/v1/agents`, {
    method: 'POST',
    body: JSON.stringify({
      session_id: `s-${name}`,
      name,
      description: `${name} does things`,
      capabilities: 'consult',
      workspace,
      kind: 'agent',
      ...extra,
    }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { agent: { id: string; name: string }; token: string };
  return { id: data.agent.id, name: data.agent.name, token: data.token, session: `s-${name}` };
}

/** auth returns the Authorization header for a test agent. */
export function auth(agent: TestAgent): Record<string, string> {
  return { authorization: `Bearer ${agent.token}` };
}

/** send posts a message as from and returns the status and parsed body. */
export async function send(
  base: string,
  from: TestAgent,
  body: Record<string, unknown>,
): Promise<{ status: number; data: SendResponse & { error?: string } }> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: auth(from),
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as SendResponse & { error?: string } };
}

/** inbox fetches an agent's inbox over HTTP. */
export async function inbox(base: string, agent: TestAgent, unreadOnly = true): Promise<Message[]> {
  const res = await fetch(`${base}/v1/agents/${agent.id}/inbox?unread_only=${String(unreadOnly)}`, {
    headers: auth(agent),
  });
  return ((await res.json()) as { messages: Message[] }).messages;
}

/**
 * parseFrames splits an SSE text chunk into frames with id, event, parsed data
 * and comment.
 */
export function parseFrames(chunk: string): Frame[] {
  return chunk
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const frame: Frame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) frame.comment = line.slice(1).trim();
        else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
        else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:')) frame.data = JSON.parse(line.slice(5).trim());
      }
      return frame;
    });
}

/**
 * openStream opens an agent's SSE stream (optionally resuming from lastEventId)
 * and returns next(count, timeoutMs, includeComments) to await frames, skipping
 * comment-only frames unless includeComments is set, plus close().
 */
export async function openStream(
  base: string,
  agent: TestAgent,
  lastEventId?: string,
): Promise<{
  response: Response;
  next: (count: number, timeoutMs?: number, includeComments?: boolean) => Promise<Frame[]>;
  close: () => void;
}> {
  const controller = new AbortController();
  const headers: Record<string, string> = auth(agent);
  if (lastEventId) headers['last-event-id'] = lastEventId;
  const response = await fetch(`${base}/v1/agents/${agent.id}/events`, {
    headers,
    signal: controller.signal,
  });
  const reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Frame[] = [];
  const next = async (
    count: number,
    timeoutMs = 2000,
    includeComments = false,
  ): Promise<Frame[]> => {
    const deadline = Date.now() + timeoutMs;
    const wanted = (): Frame[] =>
      includeComments ? frames : frames.filter((f) => f.event !== undefined);
    while (wanted().length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(`timed out waiting for ${count} frames, have ${frames.length}`);
      type ReadResult = Awaited<ReturnType<typeof reader.read>>;
      const result: ReadResult = await Promise.race([
        reader.read(),
        new Promise<ReadResult>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      frames.push(...parseFrames(parts.join('\n\n') + '\n\n'));
    }
    const out: Frame[] = [];
    while (out.length < count && frames.length > 0) {
      const f = frames.shift()!;
      if (includeComments || f.event !== undefined) out.push(f);
    }
    return out;
  };
  return { response, next, close: () => controller.abort() };
}
