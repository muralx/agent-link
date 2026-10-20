import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Hub } from '@agent-link/hub';
import { HubClient } from './hub-client.ts';
import { openEdge, startTestHub, type TestEdge } from './testkit.ts';

const ChannelNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
});

async function withEdges(
  specs: string[],
  fn: (edges: TestEdge[], hub: Hub) => Promise<void>,
): Promise<void> {
  const { hub, url } = await startTestHub();
  const edges: TestEdge[] = [];
  try {
    for (const ws of specs) edges.push(await openEdge(url, ws));
    await fn(edges, hub);
  } finally {
    for (const e of edges) await e.close();
    await hub.close();
  }
}

test('the edge advertises the channel capability, instructions and eleven tools', async () => {
  await withEdges(['w'], async ([edge]) => {
    const caps = edge!.client.getServerCapabilities();
    assert.deepEqual(caps?.experimental, { 'claude/channel': {} });
    assert.ok(caps?.tools);
    assert.match(edge!.client.getInstructions() ?? '', /register/);
    const tools = await edge!.client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      'audit',
      'await',
      'conversation',
      'conversations',
      'guard',
      'inbox',
      'peers',
      'register',
      'reply',
      'send',
      'unregister',
    ]);
    const send = tools.tools.find((t) => t.name === 'send')!;
    assert.equal(send.inputSchema.type, 'object');
    assert.ok((send.inputSchema.properties as Record<string, unknown>)['body']);
    assert.equal('$schema' in send.inputSchema, false);
  });
});

test('tools refuse to work before register and register validates its input', async () => {
  await withEdges(['w'], async ([edge]) => {
    const early = await edge!.call('send', { to: ['x'], body: 'hi' });
    assert.equal(early['error'], 'not_registered');
    const noSession = await edge!.call('register', {
      name: 'a',
      description: 'd',
      capabilities: 'c',
    });
    assert.equal(
      noSession['error'],
      'session_required',
      'no env session id, no window, none given',
    );
    const badName = await edge!.call('register', {
      session_id: 's',
      name: 'bad name!',
      description: 'd',
      capabilities: 'c',
    });
    assert.equal(badName['error'], 'invalid_message');
    const ok = await edge!.register('architect');
    assert.equal(ok['name'], 'architect');
    assert.equal(ok['workspace'], 'w');
    assert.deepEqual(ok['peers'], []);
    const raw = await edge!.client.callTool({ name: 'peers', arguments: {} });
    assert.equal(raw.isError, false);
  });
});

test('register without any workspace source fails with workspace_required', async () => {
  const { hub, url } = await startTestHub();
  const edge = await openEdge(url, 'w', { cwd: mkdtempSync(join(tmpdir(), 'agent-link-bare-')) });
  try {
    const res = await edge.call('register', {
      session_id: 's',
      name: 'a',
      description: 'd',
      capabilities: 'c',
    });
    assert.equal(res['error'], 'workspace_required');
    const explicit = await edge.call('register', {
      session_id: 's',
      name: 'a',
      description: 'd',
      capabilities: 'c',
      workspace: 'given',
    });
    assert.equal(explicit['workspace'], 'given');
  } finally {
    await edge.close();
    await hub.close();
  }
});

test('two agents converse: send, inbox, reply, await; visibility is per workspace', async () => {
  await withEdges(['w', 'w', 'other'], async ([architect, designer, stranger]) => {
    await architect!.register('architect');
    const reg = await designer!.register('designer');
    assert.deepEqual(reg['peers'], ['architect'], 'register lists peer names only');
    await stranger!.register('stranger');
    assert.deepEqual(await stranger!.call('peers'), { peers: [] });

    const sent = await designer!.call('send', {
      to: ['architect'],
      body: 'Cache per tenant?',
      expectation: 'reply',
    });
    assert.deepEqual(sent['delivered_to'], ['architect']);
    const inbox = await architect!.call('inbox', { unread_only: false });
    assert.equal(inbox['count'], 1);
    const convs = await architect!.call('conversations', { open_only: true });
    assert.equal((convs['conversations'] as unknown[]).length, 1);

    const waiting = designer!.call('await', {
      conversation_id: sent['conversation_id'],
      timeout_s: 5,
    });
    await architect!.call('reply', {
      conversation_id: sent['conversation_id'],
      body: 'Yes, keyed by tenant id.',
    });
    const got = await waiting;
    assert.equal((got['messages'] as { body: string }[])[0]?.body, 'Yes, keyed by tenant id.');
    assert.equal(got['timed_out'], false);

    const thread = await designer!.call('conversation', {
      conversation_id: sent['conversation_id'],
    });
    assert.equal((thread['messages'] as unknown[]).length, 2);
    const missing = await designer!.call('send', { to: ['nobody'], body: 'x' });
    assert.equal(missing['error'], 'peer_not_found');
    assert.deepEqual(missing['online'], ['architect']);
  });
});

test('await times out, reports progress, and honours the slice loop', async () => {
  await withEdges(['w'], async ([edge]) => {
    await edge!.register('solo');
    let progress = 0;
    const res = await edge!.client.callTool(
      { name: 'await', arguments: { timeout_s: 1 } },
      undefined,
      { onprogress: () => void progress++ },
    );
    const body = JSON.parse((res.content as { text: string }[])[0]!.text) as { timed_out: boolean };
    assert.equal(body.timed_out, true);
    assert.ok(progress >= 1, 'a progress notification was sent per slice');
  });
});

test('an inbound message becomes a channel notification and is acked as notified', async () => {
  await withEdges(['w', 'w'], async ([architect, designer], hub) => {
    await architect!.register('architect');
    await designer!.register('designer');
    const received: z.infer<typeof ChannelNotificationSchema>[] = [];
    designer!.client.setNotificationHandler(ChannelNotificationSchema, (n) => {
      received.push(n);
    });
    const sent = await architect!.call('send', {
      to: ['designer'],
      body: 'Please review the cache design',
      expectation: 'reply',
      subject: 'Caching',
    });
    await waitFor(() => received.length >= 1);
    const n = received[0]!;
    assert.equal(n.params.content, '«Caching»\n\nPlease review the cache design');
    assert.deepEqual(n.params.meta, {
      conversation_id: sent['conversation_id'],
      message_id: sent['message_id'],
      from: 'architect',
      expectation: 'reply',
      final: 'false',
      kind: 'direct',
    });
    await waitFor(
      () =>
        hub.stores.messages.deliveryState(sent['message_id'] as string, designerId(hub))?.state ===
        'notified',
    );
    assert.equal(
      hub.stores.messages.deliveryState(sent['message_id'] as string, designerId(hub))?.via,
      'channel',
    );

    const third = await openEdge(hub.url!, 'w');
    await third.register('reviewer');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1, 'a peer joining is not pushed');
    await third.close();
  });
});

test('a dead hub surfaces as hub_unavailable after one ensureHub attempt', async () => {
  const { hub, url } = await startTestHub();
  let ensured = 0;
  const edge = await openEdge(url, 'w', {
    hubClient: new HubClient('http://127.0.0.1:1'),
    ensureHub: () => {
      ensured++;
      return Promise.resolve();
    },
  });
  try {
    const res = await edge.call('register', {
      session_id: 's',
      name: 'a',
      description: 'd',
      capabilities: 'c',
    });
    assert.equal(res['error'], 'hub_unavailable');
    assert.equal(ensured, 1);
  } finally {
    await edge.close();
    await hub.close();
  }
});

function designerId(hub: Hub): string {
  return hub.stores.agents.byName('w', 'designer')!.id;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('start registers the window provisionally and the model upgrades the identity in place', async () => {
  const { hub, url } = await startTestHub();
  let ensured = 0;
  const edge = await openEdge(url, 'w', {
    env: { CLAUDE_CODE_SESSION_ID: 'sess-real', CLAUDE_PROJECT_DIR: '/home/x/My Repo!' },
    window: 'win-1',
    ensureHub: () => {
      ensured++;
      return Promise.resolve();
    },
  });
  const watcher = await openEdge(url, 'w');
  try {
    await watcher.register('watcher');
    const received: z.infer<typeof ChannelNotificationSchema>[] = [];
    watcher.client.setNotificationHandler(ChannelNotificationSchema, (n) => {
      received.push(n);
    });

    const provisional = await edge.edge.start();
    assert.equal(ensured, 1, 'start makes sure a hub is there');
    assert.equal(provisional?.provisional, true);
    assert.equal(provisional?.name, 'My-Repo');
    assert.equal(provisional?.sessionId, 'sess-real');
    const row = hub.stores.agents.bySession('sess-real');
    assert.equal(row?.provisional, true);
    assert.equal(row?.window, 'win-1');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 0, 'a peer joining wakes nobody');

    const mine: z.infer<typeof ChannelNotificationSchema>[] = [];
    edge.client.setNotificationHandler(ChannelNotificationSchema, (n) => {
      mine.push(n);
    });
    await watcher.call('send', { to: ['My-Repo'], body: 'anyone there?', expectation: 'reply' });
    await waitFor(() => mine.length >= 1);
    assert.match(
      mine[0]!.params.content,
      /anyone there\?\n\n\[agent-link\] You are still registered provisionally/,
    );

    const identified = await edge.call('register', {
      name: 'architect',
      description: 'Designs the hub',
      capabilities: 'consult on architecture',
    });
    assert.equal(identified['agent_id'], provisional?.agentId, 'same agent, no session_id needed');
    assert.equal(identified['name'], 'architect');
    assert.equal(hub.stores.agents.bySession('sess-real')?.provisional, false);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 0, 'an identification wakes nobody either');

    const inbox = await edge.call('inbox', { unread_only: false });
    assert.equal(
      (inbox['messages'] as unknown[]).length,
      1,
      'the message sent while provisional is still there',
    );
  } finally {
    await watcher.close();
    await edge.close();
    await hub.close();
  }
});

test('start stays dormant without a workspace or a session id', async () => {
  const { hub, url } = await startTestHub();
  let ensured = 0;
  const ensure = () => {
    ensured++;
    return Promise.resolve();
  };
  const bare = await openEdge(url, 'w', {
    cwd: mkdtempSync(join(tmpdir(), 'agent-link-bare-')),
    env: { CLAUDE_CODE_SESSION_ID: 'sess-x' },
    ensureHub: ensure,
  });
  const noSession = await openEdge(url, 'w', { env: {}, ensureHub: ensure });
  const windowOnly = await openEdge(url, 'w', { env: {}, window: 'win-7', ensureHub: ensure });
  try {
    assert.equal(await bare.edge.start(), undefined, 'no marker: nothing happens');
    assert.equal(
      await noSession.edge.start(),
      undefined,
      'no session id and no window: nothing happens',
    );
    assert.equal(ensured, 0, 'a dormant edge never starts a hub');
    const res = await bare.call('register', { name: 'a', description: 'd', capabilities: 'c' });
    assert.equal(res['error'], 'workspace_required');
    const noId = await noSession.call('register', {
      name: 'a',
      description: 'd',
      capabilities: 'c',
    });
    assert.equal(noId['error'], 'session_required');

    const viaWindow = await windowOnly.edge.start();
    assert.equal(
      viaWindow?.sessionId,
      'window:win-7',
      'a window id stands in for a missing session id',
    );
    assert.equal(ensured, 1);
  } finally {
    await windowOnly.close();
    await noSession.close();
    await bare.close();
    await hub.close();
  }
});

test('a hub failure during start is reported, not thrown, and tools recover later', async () => {
  const { hub, url } = await startTestHub();
  const errors: unknown[] = [];
  let target = 'http://127.0.0.1:1';
  const client = new HubClient(url);
  const flaky = new HubClient(target, (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(url.replace(/^http:\/\/127\.0\.0\.1:1/, target), init);
  });
  const edge = await openEdge(url, 'w', {
    hubClient: flaky,
    env: { CLAUDE_CODE_SESSION_ID: 'sess-f' },
    onError: (e) => errors.push(e),
  });
  try {
    assert.equal(await edge.edge.start(), undefined);
    assert.equal(errors.length, 1);
    target = url;
    const ok = await edge.call('register', { name: 'late', description: 'd', capabilities: 'c' });
    assert.equal(ok['name'], 'late');
    assert.equal((await client.sessionOpen('sess-f')).agent?.name, 'late');
  } finally {
    await edge.close();
    await hub.close();
  }
});

test("register upgrades the edge's own agent even after a hook relinked its session, and a returning name adopts its mailbox", async () => {
  const { hub, url } = await startTestHub();
  const relayOld = await openEdge(url, 'w', {
    env: { CLAUDE_CODE_SESSION_ID: 'relay-1' },
    window: 'win-old',
  });
  const asker = await openEdge(url, 'w');
  const relayNew = await openEdge(url, 'w', {
    env: { CLAUDE_CODE_SESSION_ID: 'relay-2', CLAUDE_PROJECT_DIR: '/x/repo' },
    window: 'win-new',
  });
  try {
    await asker.register('architect');
    await relayOld.edge.start();
    await relayOld.call('register', {
      name: 'alice',
      kind: 'human',
      description: 'the human',
      capabilities: 'decide',
    });
    const asked = await asker.call('send', {
      to: ['alice'],
      body: 'OK to proceed?',
      expectation: 'reply',
    });
    const oldId = relayOld.edge.session.identity!.agentId;
    await relayOld.call('unregister', {}); // the window closes before the human reads it
    await relayOld.close();
    assert.equal(hub.stores.agents.byId(oldId)?.status, 'offline');

    const placeholder = await relayNew.edge.start();
    // /resume inside the new window: the hook relinks the placeholder to another session id
    hub.stores.agents.relinkSession(placeholder!.agentId, 'relay-2-resumed');
    const back = await relayNew.call('register', {
      name: 'alice',
      kind: 'human',
      description: 'the human',
      capabilities: 'decide',
    });
    assert.equal(back['agent_id'], oldId, 'alice is the same agent as before, with its mailbox');
    assert.equal(back['name'], 'alice');
    assert.equal(back['channel'], 'enabled');
    assert.equal(
      hub.stores.agents.byId(placeholder!.agentId),
      undefined,
      'the placeholder was absorbed',
    );
    const inbox = await relayNew.call('inbox', { unread_only: false });
    const messages = inbox['messages'] as { conversation_id: string; body: string }[];
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.conversation_id, asked['conversation_id']);
    assert.equal(messages[0]!.body, 'OK to proceed?');
    const peers = (await asker.call('peers'))['peers'] as { name: string }[];
    assert.deepEqual(
      peers.map((p) => p.name),
      ['alice'],
      'no duplicate alice and no stray placeholder',
    );
  } finally {
    await asker.close();
    await relayNew.close();
    await hub.close();
  }
});

test('without the channels flag the edge emits nothing, keeps deliveries queued for the hooks and says so in register', async () => {
  const { hub, url } = await startTestHub();
  const deaf = await openEdge(url, 'w', {
    env: { CLAUDE_CODE_SESSION_ID: 'deaf-1' },
    window: 'win-deaf',
    channel: false,
  });
  const asker = await openEdge(url, 'w');
  try {
    await asker.register('architect');
    await deaf.edge.start();
    const received: unknown[] = [];
    deaf.client.setNotificationHandler(ChannelNotificationSchema, (n) => {
      received.push(n);
    });
    const res = await deaf.call('register', {
      name: 'alice',
      kind: 'human',
      description: 'the human',
      capabilities: 'decide',
    });
    assert.equal(res['channel'], 'unavailable');
    assert.match(String(res['warning']), /started without --dangerously-load-development-channels/);
    const asked = await asker.call('send', {
      to: ['alice'],
      body: 'anyone?',
      expectation: 'reply',
    });
    assert.deepEqual(asked['delivered_to'], ['alice']);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 0, 'no channel notification was emitted');
    const pending = await new HubClient(url).sessionPending('deaf-1');
    assert.equal(pending.messages.length, 1, 'the hook finds the message still waiting');
    assert.equal(pending.messages[0]!.body, 'anyone?');
  } finally {
    await asker.close();
    await deaf.close();
    await hub.close();
  }
});

test('an answer that await returns is not pushed as well, and peers lists only what matters', async () => {
  await withEdges(['w', 'w', 'w'], async ([architect, designer, relay]) => {
    await architect!.register('architect');
    await designer!.register('designer');
    await relay!.call('register', {
      session_id: relay!.sessionId,
      name: 'dana',
      kind: 'human',
      description: 'the human',
      capabilities: 'decide',
    });
    const pushed: z.infer<typeof ChannelNotificationSchema>[] = [];
    designer!.client.setNotificationHandler(ChannelNotificationSchema, (n) => {
      pushed.push(n);
    });
    const asked = await designer!.call('send', {
      to: ['architect'],
      body: 'Cache per tenant?',
      expectation: 'reply',
    });
    const waiting = designer!.call('await', {
      conversation_id: asked['conversation_id'],
      timeout_s: 5,
    });
    await new Promise((r) => setTimeout(r, 50));
    await architect!.call('reply', {
      conversation_id: asked['conversation_id'],
      body: 'Yes.',
      expectation: 'reply',
    });
    const got = await waiting;
    assert.equal((got['messages'] as { body: string }[])[0]?.body, 'Yes.');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(pushed.length, 0, 'the answer arrived once, through await');

    const peers = (await designer!.call('peers'))['peers'] as Record<string, unknown>[];
    assert.deepEqual(
      peers.find((p) => p['name'] === 'architect'),
      { name: 'architect', description: 'architect does things', capabilities: 'consult' },
    );
    assert.equal(peers.find((p) => p['name'] === 'dana')?.['kind'], 'human');
    const again = await designer!.call('register', {
      session_id: designer!.sessionId,
      name: 'designer',
      description: 'designer does things',
      capabilities: 'consult',
    });
    assert.deepEqual(again['humans'], ['dana']);
  });
});
