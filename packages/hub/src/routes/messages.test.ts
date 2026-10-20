import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ConversationSummary,
  Message,
  OpenResponse,
  PendingResponse,
} from '@agent-link/protocol';
import { auth, inbox, registerAgent, send, withHub } from './testkit.ts';

test('send, inbox, thread, conversations and validation over http', async () => {
  await withHub(async (_hub, base) => {
    const a = await registerAgent(base, 'a');
    const b = await registerAgent(base, 'b');
    const c = await registerAgent(base, 'c');

    const first = await send(base, a, {
      to: ['b'],
      body: 'q1',
      expectation: 'reply',
      subject: 'S',
    });
    assert.equal(first.status, 201);
    assert.deepEqual(first.data.delivered_to, ['b']);
    const convId = first.data.conversation_id;
    const second = await send(base, a, { conversation_id: convId, body: 'q2' });
    assert.equal(second.status, 201);

    const unread = await inbox(base, b);
    assert.deepEqual(
      unread.map((m) => m.body),
      ['q1', 'q2'],
    );
    assert.deepEqual(await inbox(base, b), []);
    assert.equal((await inbox(base, b, false)).length, 2);

    const outsider = await fetch(`${base}/v1/conversations/${convId}`, { headers: auth(c) });
    assert.equal(outsider.status, 403);
    const sinceRes = await fetch(
      `${base}/v1/conversations/${convId}?since=${first.data.message_id}`,
      {
        headers: auth(a),
      },
    );
    assert.equal(sinceRes.status, 200);
    const since = (await sinceRes.json()) as { messages: Message[]; participants: string[] };
    assert.deepEqual(
      since.messages.map((m) => m.id),
      [second.data.message_id],
    );
    assert.deepEqual(since.participants, ['a', 'b']);

    const forB = await fetch(`${base}/v1/agents/${b.id}/conversations`, { headers: auth(b) });
    const listB = (await forB.json()) as ConversationSummary[];
    assert.equal(listB[0]?.open_for_me[0]?.message_id, first.data.message_id);
    const forA = await fetch(`${base}/v1/agents/${a.id}/conversations?open_only=true`, {
      headers: auth(a),
    });
    assert.deepEqual(await forA.json(), []);

    const tooBig = await send(base, a, { to: ['b'], body: 'x'.repeat(70_000) });
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.data.error, 'invalid_message');
    const empty = await send(base, a, { to: ['b'], body: '' });
    assert.equal(empty.status, 400);
    const missing = await send(base, a, { to: ['zzz'], body: 'x' });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, 'peer_not_found');
    const anon = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ to: ['b'], body: 'x' }),
    });
    assert.equal(anon.status, 401);
  });
});

test('open is read-only while pending shows the message once; reclaim delivers what was missed', async () => {
  await withHub(async (hub, base) => {
    const a = await registerAgent(base, 'a');
    const b = await registerAgent(base, 'b');
    const q = await send(base, a, { to: ['b'], body: 'q', expectation: 'reply' });

    const open = (await (
      await fetch(`${base}/v1/sessions/${b.session}/open`)
    ).json()) as OpenResponse;
    assert.equal(open.open_replies[0]?.message_id, q.data.message_id);
    assert.equal(hub.stores.messages.deliveryState(q.data.message_id, b.id)?.state, 'queued');

    const pending = (await (
      await fetch(`${base}/v1/sessions/${b.session}/pending`)
    ).json()) as PendingResponse;
    assert.equal(pending.messages.length, 1);
    assert.equal(hub.stores.messages.deliveryState(q.data.message_id, b.id)?.state, 'read');

    const del = await fetch(`${base}/v1/agents/${b.id}`, { method: 'DELETE', headers: auth(b) });
    assert.equal(del.status, 204);
    const reply = await send(base, a, {
      conversation_id: q.data.conversation_id,
      body: 'ping while away',
    });
    assert.deepEqual(reply.data.offline, ['b']);

    const back = await registerAgent(base, 'b');
    assert.equal(back.id, b.id);
    const got = await inbox(base, back);
    assert.ok(got.some((m) => m.body === 'ping while away'));
  });
});

test('delivery ack transitions state', async () => {
  await withHub(async (hub, base) => {
    const a = await registerAgent(base, 'a');
    const b = await registerAgent(base, 'b');
    const q = await send(base, a, { to: ['b'], body: 'q' });
    const ack = await fetch(`${base}/v1/deliveries/${q.data.message_id}/${b.id}`, {
      method: 'POST',
      headers: auth(b),
      body: JSON.stringify({ state: 'notified', via: 'channel' }),
    });
    assert.equal(ack.status, 204);
    assert.equal(hub.stores.messages.deliveryState(q.data.message_id, b.id)?.via, 'channel');
    const forged = await fetch(`${base}/v1/deliveries/${q.data.message_id}/${b.id}`, {
      method: 'POST',
      headers: auth(a),
      body: JSON.stringify({ state: 'read', via: 'inbox' }),
    });
    assert.equal(forged.status, 403);
  });
});
