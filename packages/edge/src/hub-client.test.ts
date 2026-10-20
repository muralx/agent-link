import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub, type Hub } from '@agent-link/hub';
import type { HubEvent } from '@agent-link/protocol';
import { HubApiError, HubClient } from './hub-client.ts';

async function withHub(fn: (hub: Hub, client: HubClient) => Promise<void>) {
  const hub = createHub({ dbPath: ':memory:', port: 0, keepaliveMs: 60_000 });
  const url = await hub.listen();
  try {
    await fn(hub, new HubClient(url));
  } finally {
    await hub.close();
  }
}

const profile = (name: string) => ({
  session_id: `s-${name}`,
  name,
  description: `${name} does things`,
  capabilities: 'consult',
  workspace: 'w',
  kind: 'agent' as const,
  cwd: '/repo',
});

test('the client covers every route with validated results', async () => {
  await withHub(async (_hub, client) => {
    assert.equal((await client.health()).ok, true);
    const up = await client.sessionUpsert({ session_id: 's-a', cwd: '/repo', workspace_hint: 'w' });
    assert.equal(up.agent, null);

    const a = await client.register(profile('a'));
    const b = await client.register(profile('b'));
    assert.deepEqual(
      (await client.peers('w', a.token)).map((p) => p.name),
      ['b'],
    );

    const sent = await client.send(a.token, {
      to: ['b'],
      body: 'hi',
      expectation: 'reply',
      final: false,
    });
    assert.deepEqual(sent.delivered_to, ['b']);
    const pending = await client.sessionPending('s-b');
    assert.equal(pending.messages[0]?.body, 'hi');
    assert.deepEqual(pending.agent, { name: 'b', kind: 'agent', provisional: false });
    const open = await client.sessionOpen('s-b', 'win-b');
    assert.equal(open.agent?.name, 'b');
    assert.equal(open.open_replies.length, 1);

    const unread = await client.inbox(b.agent.id, b.token, { unread_only: true, limit: 10 });
    assert.equal(unread.messages.length, 0, 'the hook already showed it');
    const inbox = await client.inbox(b.agent.id, b.token, { unread_only: false, limit: 10 });
    assert.equal(inbox.messages.length, 1);
    const thread = await client.conversation(b.token, sent.conversation_id);
    assert.equal(thread.messages.length, 1);
    const list = await client.conversations(b.agent.id, b.token, false);
    assert.equal(list.length, 1);

    const waiting = client.await(a.agent.id, a.token, { timeout_s: 5 });
    await client.send(b.token, {
      conversation_id: sent.conversation_id,
      body: 'answer',
      expectation: 'none',
      final: false,
    });
    const got = await waiting;
    assert.equal(got.messages[0]?.body, 'answer');

    await client.ackDelivery(sent.message_id, b.agent.id, b.token, 'read', 'inbox');
    await client.unregister(a.agent.id, a.token);
    await client.sessionEnd('s-b', 'win-b');
    assert.deepEqual(await client.peers('w', (await client.register(profile('c'))).token), []);
  });
});

test('api errors become HubApiError and a dead hub is hub_unavailable', async () => {
  await withHub(async (_hub, client) => {
    const a = await client.register(profile('a'));
    const err = await client
      .send(a.token, { to: ['ghost'], body: 'x', expectation: 'none', final: false })
      .catch((e: unknown) => e);
    assert.ok(err instanceof HubApiError);
    assert.equal(err.code, 'peer_not_found');
    assert.deepEqual(err.extra['online'], []);
    const bad = await client.peers('w', 'nope').catch((e: unknown) => e);
    assert.ok(bad instanceof HubApiError && bad.code === 'unauthorized');
  });
  const dead = new HubClient('http://127.0.0.1:1');
  const err = await dead.health().catch((e: unknown) => e);
  assert.ok(err instanceof HubApiError);
  assert.equal(err.code, 'hub_unavailable');
});

test('subscribeEvents streams events and resumes after the hub drops the stream', async () => {
  await withHub(async (hub, client) => {
    const a = await client.register(profile('a'));
    const b = await client.register(profile('b'));
    const events: HubEvent[] = [];
    let connects = 0;
    const sub = client.subscribeEvents(b.agent.id, b.token, {
      onEvent: (e) => events.push(e),
      onConnect: () => connects++,
      backoffMs: 20,
    });
    try {
      await run();
    } finally {
      sub.stop();
    }

    async function run(): Promise<void> {
      await waitFor(() => connects === 1);
      await client.send(a.token, { to: ['b'], body: 'one', expectation: 'none', final: false });
      await waitFor(() => events.length === 1);
      hub.closeStreams();
      await client.send(a.token, { to: ['b'], body: 'two', expectation: 'none', final: false });
      await waitFor(() => events.length === 2 && connects === 2, 3000);
      const bodies = events.map((e) => (e.type === 'message' ? e.message.body : e.type));
      assert.deepEqual(bodies, ['one', 'two']);
      sub.stop();
      await client.send(a.token, { to: ['b'], body: 'three', expectation: 'none', final: false });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(events.length, 2);
    }
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
