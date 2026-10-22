import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AwaitResponse, HubEvent } from '@agent-link/protocol';
import { auth, openStream, registerAgent, send, withHub } from './testkit.ts';

test('sse stream delivers messages, peer events and keepalives', async () => {
  await withHub(
    async (_hub, base) => {
      const a = await registerAgent(base, 'a');
      const b = await registerAgent(base, 'b');
      const stream = await openStream(base, b);
      assert.equal(stream.response.headers.get('content-type'), 'text/event-stream');

      await send(base, a, { to: ['b'], body: 'hello', expectation: 'reply', subject: 'S' });
      const [msg] = await stream.next(1);
      assert.equal(msg?.event, 'message');
      const data = msg?.data as HubEvent;
      assert.equal(data.type, 'message');
      if (data.type === 'message') {
        assert.equal(data.message.body, 'hello');
        assert.equal(data.subject, 'S');
        assert.deepEqual(data.participants, ['a', 'b']);
      }
      assert.ok(msg?.id);

      await registerAgent(base, 'c');
      const [peer] = await stream.next(1);
      assert.equal(peer?.event, 'peer');
      assert.equal((peer?.data as HubEvent & { name: string }).name, 'c');

      const comments = await stream.next(1, 2000, true);
      assert.equal(comments[0]?.comment, 'keepalive');
      stream.close();
    },
    { keepaliveMs: 50 },
  );
});

test('a fresh stream replays queued deliveries and Last-Event-ID skips older ones', async () => {
  await withHub(
    async (_hub, base) => {
      const a = await registerAgent(base, 'a');
      const b = await registerAgent(base, 'b');
      await send(base, a, { to: ['b'], body: 'one' });
      await send(base, a, { to: ['b'], body: 'two' });

      const s1 = await openStream(base, b);
      const frames = await s1.next(2);
      assert.deepEqual(
        frames.map((f) => (f.data as { message: { body: string } }).message.body),
        ['one', 'two'],
      );
      s1.close();

      const s2 = await openStream(base, b, frames[0]?.id);
      const [only] = await s2.next(1);
      assert.equal((only?.data as { message: { body: string } }).message.body, 'two');
      s2.close();
    },
    { keepaliveMs: 60_000 },
  );
});

test('await returns immediately on existing unread, waits for new, and times out', async () => {
  await withHub(async (_hub, base) => {
    const a = await registerAgent(base, 'a');
    const b = await registerAgent(base, 'b');
    const url = (q: string) => `${base}/v1/agents/${b.id}/await?${q}`;

    const t0 = Date.now();
    const empty = (await (
      await fetch(url('timeout_s=1'), { headers: auth(b) })
    ).json()) as AwaitResponse;
    assert.equal(empty.timed_out, true);
    assert.ok(Date.now() - t0 >= 900);

    await send(base, a, { to: ['b'], body: 'already here' });
    const existing = (await (
      await fetch(url('timeout_s=5'), { headers: auth(b) })
    ).json()) as AwaitResponse;
    assert.equal(existing.messages[0]?.body, 'already here');
    assert.equal(existing.timed_out, false);

    const pending = fetch(url('timeout_s=5'), { headers: auth(b) });
    await new Promise((r) => setTimeout(r, 50));
    const sent = await send(base, a, { to: ['b'], body: 'fresh', expectation: 'reply' });
    const live = (await (await pending).json()) as AwaitResponse;
    assert.equal(live.messages[0]?.body, 'fresh');

    const other = await send(base, a, { to: ['b'], body: 'elsewhere' });
    const filtered = fetch(url(`timeout_s=1&conversation=${sent.data.conversation_id}`), {
      headers: auth(b),
    });
    const reply = await send(base, b, {
      conversation_id: sent.data.conversation_id,
      body: 'answer',
    });
    const inConv = (await (await filtered).json()) as AwaitResponse;
    assert.equal(inConv.timed_out, true, 'own reply must not satisfy my own await');
    void other;

    const after = fetch(
      `${base}/v1/agents/${a.id}/await?message=${sent.data.message_id}&timeout_s=5`,
      { headers: auth(a) },
    );
    const forA = (await (await after).json()) as AwaitResponse;
    assert.deepEqual(
      forA.messages.map((m) => m.id),
      [reply.data.message_id],
    );

    const clamped = await fetch(`${base}/v1/agents/${a.id}/await?timeout_s=999`, {
      headers: auth(a),
      signal: AbortSignal.timeout(500),
    }).catch((e: Error) => e);
    assert.ok(clamped instanceof Error, 'a clamped 25 s wait is still longer than 500 ms');
  });
});

test('message events say who to wake: fyi between agents waits, questions, answers and humans wake', async () => {
  await withHub(
    async (_hub, base) => {
      const a = await registerAgent(base, 'a');
      const b = await registerAgent(base, 'b');
      const h = await registerAgent(base, 'h', 'w', { kind: 'human' });
      const toB = await openStream(base, b);
      const toH = await openStream(base, h);
      const wake = async (stream: Awaited<ReturnType<typeof openStream>>) => {
        const [frame] = await stream.next(1);
        const data = frame?.data as HubEvent;
        assert.equal(data.type, 'message');
        return data.type === 'message' ? data.wake : undefined;
      };

      await send(base, a, { to: ['b'], body: 'fyi', expectation: 'none' });
      assert.equal(await wake(toB), false, 'fyi from an agent to an agent does not wake');
      await send(base, a, { to: ['b'], body: 'question', expectation: 'reply' });
      assert.equal(await wake(toB), true, 'a question wakes');
      await send(base, h, { to: ['b'], body: 'pull', expectation: 'none' });
      assert.equal(await wake(toB), true, 'a human always wakes');
      await send(base, a, { to: ['h'], body: 'fyi human', expectation: 'none' });
      assert.equal(await wake(toH), true, 'a human relay is always woken');

      const toA = await openStream(base, a);
      const asked = await send(base, a, { to: ['b'], body: 'which?', expectation: 'reply' });
      assert.equal(await wake(toB), true);
      await send(base, b, {
        conversation_id: asked.data.conversation_id,
        body: 'this one',
        expectation: 'none',
      });
      assert.equal(await wake(toA), true, 'an answer to a waiting question wakes the asker');
      await send(base, b, {
        conversation_id: asked.data.conversation_id,
        body: 'also',
        expectation: 'none',
      });
      assert.equal(await wake(toA), false, 'once answered, a fyi waits again');
      toA.close();

      const announced = await send(base, a, { to: ['b', 'h'], body: 'all', expectation: 'none' });
      const [frame] = await toB.next(1);
      const data = frame?.data as HubEvent;
      if (data.type === 'message') {
        assert.equal(data.kind, 'announcement');
        assert.equal(data.starter, 'a');
      }
      assert.equal(announced.data.kind, 'announcement');
      toB.close();
      toH.close();
    },
    { keepaliveMs: 60_000 },
  );
});

test('a replayed answer to a waiting question still wakes the asker', async () => {
  await withHub(
    async (_hub, base) => {
      const a = await registerAgent(base, 'a');
      const b = await registerAgent(base, 'b');
      const asked = await send(base, a, { to: ['b'], body: 'which?', expectation: 'reply' });
      await send(base, b, {
        conversation_id: asked.data.conversation_id,
        body: 'this one',
        expectation: 'none',
      });
      const toA = await openStream(base, a);
      const [frame] = await toA.next(1);
      const data = frame?.data as HubEvent;
      assert.equal(data.type === 'message' && data.wake, true);
      toA.close();
    },
    { keepaliveMs: 60_000 },
  );
});
