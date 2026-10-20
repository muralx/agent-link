#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { workspaceDir } from '@agent-link/edge/testkit';

const EDGE_BIN = fileURLToPath(new URL('../packages/edge/src/bin.ts', import.meta.url));

/**
 * ChannelNotificationSchema is the zod shape of a channel notification an edge
 * pushes to its MCP client: method `notifications/claude/channel` with a
 * `content` string and an optional string-to-string `meta` record.
 *
 * openEdge registers it as the notification handler schema on each spawned
 * edge's client so the scenario can collect every channel notification, with a
 * missing meta recorded as an empty record. Any notification whose method or
 * params differ is left for other handlers.
 */
const ChannelNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
});

/**
 * Edge is one spawned edge in the scenario: its MCP client, session id,
 * captured stderr and channel notifications, and a call helper.
 */
interface Edge {
  name: string;
  client: Client;
  sessionId: string;
  /**
   * stderr collects the edge process's stderr chunks, reported when the
   * scenario fails.
   */
  stderr: string[];
  notifications: { content: string; meta: Record<string, string> }[];
  call: (tool: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

/** freePort returns a TCP port that was free a moment ago. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      srv.close(() => resolve(addr.port));
    });
  });
}

/**
 * openEdge spawns one agent-link-edge process with the given cwd and
 * environment plus its own CLAUDE_CODE_SESSION_ID and AGENT_LINK_WINDOW (so the
 * edge registers provisionally on start, as under Claude Code, without sharing
 * a window with the other edges) and AGENT_LINK_CHANNEL=on (the test client
 * accepts channel notifications whatever process runs the script), connects an
 * MCP client to it over stdio and records every channel notification it emits.
 */
async function openEdge(
  name: string,
  workspace: string,
  env: Record<string, string>,
): Promise<Edge> {
  const cwd = workspaceDir(workspace);
  const sessionId = `e2e-${name}-${process.pid}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-warnings=ExperimentalWarning', EDGE_BIN],
    cwd,
    env: {
      ...env,
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_PROJECT_DIR: cwd,
      // every edge is its own window; under one Claude process they would otherwise share one
      AGENT_LINK_WINDOW: `${sessionId}-window`,
      // the test client accepts channel notifications even if the Claude process running this script would not
      AGENT_LINK_CHANNEL: 'on',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: `e2e-${name}`, version: '0.0.0' }, { capabilities: {} });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  const notifications: Edge['notifications'] = [];
  client.setNotificationHandler(ChannelNotificationSchema, (n) => {
    notifications.push({ content: n.params.content, meta: n.params.meta ?? {} });
  });
  await client.connect(transport);
  const call = async (
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const res = await client.callTool({ name: tool, arguments: args });
    const content = res.content as { text: string }[];
    return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
  };
  return { name, client, sessionId, stderr, notifications, call, close: () => client.close() };
}

/**
 * expect throws an e2e failure with the message when the condition is falsy.
 */
function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(`e2e failed: ${message}`);
}

/** waitFor polls a predicate every 25 ms until it holds or timeoutMs passes. */
async function waitFor(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`e2e failed: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * runScenario is the end-to-end check with real processes: it drives the whole
 * agent-link protocol through agent-link-edge processes against a hub it
 * spawns, and throws on the first assertion that fails.
 *
 * It picks a free port and a temp data directory, then starts three edges over
 * stdio (architect and designer in ws1, stranger in ws2); the first edge spawns
 * agent-linkd. Each edge has its own session and window id, so it registers
 * provisionally on start, and the three then identify themselves without
 * passing session ids. It asserts workspace visibility, that joining and
 * identifying wake nobody, channel notification delivery (subject and body
 * only, the rest in the tag's meta), a reply received through await, a
 * workspace-scoped broadcast that, being information between agents, waits in
 * the designer's inbox instead of waking it, and the offline rules (send to an
 * unregistered peer fails with peer_not_found, a reply to an offline
 * participant is recorded as offline).
 *
 * It also exercises announcements and the guard with two more edges in ws1, a
 * human relay (alice) and a watcher: the relay's send to * is an announcement
 * whose answer from architect reaches only the relay, never designer; designer
 * repeating one message is quarantined on the sixth send, the relay is told by
 * guard over the channel, peers marks designer quarantined, the watcher's audit
 * feed shows the five delivered repeats, designer cannot release itself
 * (unauthorized), the relay releases it and designer can send again.
 *
 * On failure the thrown error carries the original message and every edge's
 * stderr, with the original error as cause. In every case it then closes all
 * edges, sends SIGTERM to the hub named in hub.json and waits up to 5 s for
 * hub.json to disappear. log receives one line per stage and defaults to a
 * no-op. The whole run needs about 60 s at most (the wrapping test's timeout).
 */
export async function runScenario(log: (line: string) => void = () => undefined): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-link-e2e-'));
  const port = await freePort();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AGENT_LINK_DATA_DIR: dataDir,
    AGENT_LINK_HUB: `http://127.0.0.1:${port}`,
  };
  const edges: Edge[] = [];
  try {
    const [architect, designer, stranger] = await Promise.all([
      openEdge('architect', 'ws1', env),
      openEdge('designer', 'ws1', env),
      openEdge('stranger', 'ws2', env),
    ]);
    edges.push(architect, designer, stranger);
    log(`hub spawned by an edge; hub.json present: ${existsSync(join(dataDir, 'hub.json'))}`);

    // start() runs after the transport connects, so the provisional registrations may still be in flight.
    let provisionalPeers: { name: string; provisional: boolean }[] = [];
    const deadline = Date.now() + 5000;
    while (provisionalPeers.length === 0) {
      const res = await designer.call('peers');
      provisionalPeers = (res['peers'] as typeof provisionalPeers | undefined) ?? [];
      if (provisionalPeers.length > 0) break;
      if (Date.now() > deadline)
        throw new Error(`e2e failed: no provisional peers: ${JSON.stringify(res)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(
      provisionalPeers.length === 1 && provisionalPeers[0]!.provisional,
      `designer sees the provisional architect: ${JSON.stringify(provisionalPeers)}`,
    );
    log('edges registered themselves provisionally on start');

    for (const e of edges) {
      const res = await e.call('register', {
        name: e.name,
        description: `${e.name} in the e2e scenario`,
        capabilities: 'consult',
      });
      expect(
        res['name'] === e.name,
        `${e.name} registered as ${String(res['name'])}: ${JSON.stringify(res)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(
      designer.notifications.length === 0,
      `joining and identifying woke nobody: ${JSON.stringify(designer.notifications)}`,
    );
    log('three agents identified without passing a session id, waking nobody');

    const strangerPeers = (await stranger.call('peers'))['peers'] as unknown[];
    expect(strangerPeers.length === 0, 'stranger sees nobody');
    const designerPeers = (await designer.call('peers'))['peers'] as { name: string }[];
    expect(designerPeers.map((p) => p.name).join() === 'architect', 'designer sees only architect');
    log('workspace visibility holds');

    const asked = await designer.call('send', {
      to: ['architect'],
      body: 'Should the cache be per tenant?',
      expectation: 'reply',
      subject: 'Caching',
    });
    expect(Array.isArray(asked['delivered_to']), `send failed: ${JSON.stringify(asked)}`);
    const isMessage = (x: { meta: Record<string, string> }): boolean =>
      x.meta['message_id'] !== undefined;
    await waitFor(
      () => architect.notifications.some(isMessage),
      "architect's channel notification",
    );
    const n = architect.notifications.find(isMessage)!;
    expect(
      n.meta['from'] === 'designer' &&
        n.meta['expectation'] === 'reply' &&
        n.meta['kind'] === 'direct',
      `channel meta: ${JSON.stringify(n.meta)}`,
    );
    expect(
      n.content === '«Caching»\n\nShould the cache be per tenant?',
      `channel content: ${n.content}`,
    );
    expect(
      n.meta['conversation_id'] === asked['conversation_id'],
      'channel meta carries the conversation',
    );
    log('channel notification delivered to the architect');

    const waiting = designer.call('await', {
      conversation_id: asked['conversation_id'],
      timeout_s: 10,
    });
    const replied = await architect.call('reply', {
      conversation_id: asked['conversation_id'],
      body: 'Yes, keyed by tenant id.',
    });
    expect((replied['delivered_to'] as string[])[0] === 'designer', 'reply delivered to designer');
    const answer = await waiting;
    expect(
      (answer['messages'] as { body: string }[])[0]?.body === 'Yes, keyed by tenant id.',
      'await returned the reply',
    );
    const open = (await architect.call('conversations', { open_only: true }))[
      'conversations'
    ] as unknown[];
    expect(open.length === 0, 'architect has nothing open after replying');
    log('question answered through await');

    const broadcast = await architect.call('send', {
      to: '*',
      body: 'Heads up: hub API changes tomorrow.',
    });
    expect(
      (broadcast['delivered_to'] as string[]).join() === 'designer',
      'broadcast reaches designer only',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(
      !designer.notifications.some((x) => x.content.includes('Heads up')),
      'information between agents does not wake the designer',
    );
    const waitingFyi = (await designer.call('inbox'))['messages'] as { body: string }[];
    expect(
      waitingFyi.some((m) => m.body.includes('Heads up')),
      `the fyi waits for the designer's next turn: ${JSON.stringify(waitingFyi)}`,
    );
    log('broadcast stayed inside the workspace and woke nobody');

    const relay = await openEdge('alice', 'ws1', env);
    const watcher = await openEdge('watcher', 'ws1', env);
    edges.push(relay, watcher);
    const profile = { description: 'e2e', capabilities: 'none' };
    const asHuman = await relay.call('register', { name: 'alice', kind: 'human', ...profile });
    expect(asHuman['kind'] === 'human', `relay registered: ${JSON.stringify(asHuman)}`);
    const asWatcher = await watcher.call('register', {
      name: 'watcher',
      watcher: true,
      ...profile,
    });
    expect(asWatcher['watcher'] === true, `watcher registered: ${JSON.stringify(asWatcher)}`);
    await waitFor(
      () => relay.notifications.some((x) => x.content.includes('registered as a watcher')),
      "the relay's notice that a watcher registered",
    );
    const cursor = (await watcher.call('audit', { action: 'feed' }))['cursor'];

    const pull = await relay.call('send', {
      to: '*',
      body: 'Pull your repository.',
      expectation: 'reply',
    });
    expect(
      pull['kind'] === 'announcement',
      `a send to * is an announcement: ${JSON.stringify(pull)}`,
    );
    await waitFor(
      () => designer.notifications.some((x) => x.content.includes('Pull your repository.')),
      "the designer's copy of the announcement",
    );
    const pulled = await architect.call('reply', {
      conversation_id: pull['conversation_id'],
      body: 'Pulled.',
    });
    expect(
      (pulled['delivered_to'] as string[]).join() === 'alice',
      `an answer to an announcement reaches only its starter: ${JSON.stringify(pulled)}`,
    );
    await waitFor(
      () => relay.notifications.some((x) => x.content.includes('Pulled.')),
      "the relay's copy of the answer",
    );
    expect(
      !designer.notifications.some((x) => x.content.includes('Pulled.')),
      'the other recipients never see the answer',
    );
    log('an announcement collects answers at its starter only');

    let blocked: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) {
      blocked = await designer.call('send', { to: ['architect'], body: 'are we there yet?' });
    }
    expect(blocked['error'] === 'quarantined', `sixth repeat refused: ${JSON.stringify(blocked)}`);
    await waitFor(
      () =>
        relay.notifications.some(
          (x) => x.meta['from'] === 'guard' && x.content.includes('**designer** was quarantined'),
        ),
      "the relay's quarantine notice from guard",
    );
    const seen = (await architect.call('peers'))['peers'] as {
      name: string;
      quarantined: boolean;
    }[];
    expect(
      seen.find((p) => p.name === 'designer')?.quarantined,
      'peers marks designer quarantined',
    );
    const fed = (await watcher.call('audit', { action: 'feed', since: cursor }))['messages'];
    expect(
      (fed as { body: string }[]).filter((m) => m.body === 'are we there yet?').length === 5,
      `the watcher's feed shows the five repeats: ${JSON.stringify(fed)}`,
    );
    const denied = await designer.call('guard', { action: 'release', name: 'designer' });
    expect(denied['error'] === 'unauthorized', 'an agent cannot release itself');
    const released = await relay.call('guard', { action: 'release', name: 'designer' });
    expect(released['action'] === 'released', `relay released: ${JSON.stringify(released)}`);
    const again = await designer.call('send', { to: ['architect'], body: 'sorry about that' });
    expect(again['message_id'], `designer sends again: ${JSON.stringify(again)}`);
    log('guard quarantined a repeating agent, told the human, and the human released it');

    await architect.call('unregister');
    const gone = await designer.call('send', { to: ['architect'], body: 'still there?' });
    expect(gone['error'] === 'peer_not_found', `send to offline peer: ${JSON.stringify(gone)}`);
    const late = await designer.call('reply', {
      conversation_id: asked['conversation_id'],
      body: 'thanks!',
    });
    expect(
      (late['offline'] as string[])[0] === 'architect',
      `reply to offline participant recorded: ${JSON.stringify(late)}`,
    );
    log('offline handling as specified');
  } catch (err) {
    const trail = edges
      .map((e) => `${e.name} stderr: ${e.stderr.join('') || '(empty)'}`)
      .join('\n');
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${trail}`, {
      cause: err,
    });
  } finally {
    for (const e of edges) await e.close().catch(() => undefined);
    const hubJson = join(dataDir, 'hub.json');
    if (existsSync(hubJson)) {
      const { pid } = JSON.parse(readFileSync(hubJson, 'utf8')) as { pid: number };
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
      await waitFor(() => !existsSync(hubJson), 'hub shutdown', 5000).catch(() => undefined);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runScenario((line) => process.stdout.write(`${line}\n`))
    .then(() => process.stdout.write('e2e ok\n'))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
