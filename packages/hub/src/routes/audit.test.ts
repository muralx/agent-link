import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AuditConversation,
  AuditFeedResponse,
  ConversationResponse,
} from '@agent-link/protocol';
import { auth, inbox, registerAgent, send, withHub, type TestAgent } from './testkit.ts';

/** get fetches an audit path as agent and returns status and parsed body. */
async function get<T>(base: string, agent: TestAgent, path: string): Promise<[number, T]> {
  const res = await fetch(`${base}/v1/workspaces/w/audit/${path}`, { headers: auth(agent) });
  return [res.status, (await res.json()) as T];
}

test('a watcher reads every conversation without touching delivery state; agents may not', async () => {
  await withHub(async (_hub, base) => {
    const watcher = await registerAgent(base, 'watcher', 'w', { watcher: true });
    const human = await registerAgent(base, 'alice', 'w', { kind: 'human' });
    const a = await registerAgent(base, 'a');
    const b = await registerAgent(base, 'b');
    const first = await send(base, a, { to: ['b'], body: 'hello', subject: 'S' });
    await send(base, b, { conversation_id: first.data.conversation_id, body: 'hi' });
    const other = await send(base, b, { to: ['a'], body: 'second thread' });

    const [denied] = await get(base, a, 'conversations');
    assert.equal(denied, 403);
    const [ok, list] = await get<AuditConversation[]>(base, watcher, 'conversations');
    assert.equal(ok, 200);
    const mine = list.filter((c) => c.participants.includes('a'));
    assert.deepEqual(
      mine.map((c) => [c.id, c.subject, c.messages]),
      [
        [other.data.conversation_id, null, 1],
        [first.data.conversation_id, 'S', 2],
      ],
    );
    assert.deepEqual(mine[1]?.participants, ['a', 'b']);

    const [, thread] = await get<ConversationResponse>(
      base,
      human,
      `conversations/${first.data.conversation_id}`,
    );
    assert.deepEqual(
      thread.messages.map((m) => m.body),
      ['hello', 'hi'],
    );
    assert.deepEqual(
      (await inbox(base, a)).map((m) => m.body),
      ['hi', 'second thread'],
      'reading the audit view marked nothing read',
    );
    const [missing] = await get(base, watcher, 'conversations/cv_nope');
    assert.equal(missing, 404);
  });
});

test('the feed starts from now, pages with a cursor and long-polls for new messages', async () => {
  await withHub(async (_hub, base) => {
    const watcher = await registerAgent(base, 'watcher', 'w', { watcher: true });
    const a = await registerAgent(base, 'a');
    await registerAgent(base, 'b');
    const [, empty] = await get<AuditFeedResponse>(base, watcher, 'messages');
    assert.deepEqual(empty, { messages: [], cursor: null, timed_out: false });

    const m1 = await send(base, a, { to: ['b'], body: 'one' });
    const [, start] = await get<AuditFeedResponse>(base, watcher, 'messages');
    assert.deepEqual(start.messages, []);
    assert.equal(start.cursor, m1.data.message_id);

    await send(base, a, { to: ['b'], body: 'two' });
    await send(base, a, { to: ['b'], body: 'three' });
    const [, page] = await get<AuditFeedResponse>(
      base,
      watcher,
      `messages?since=${start.cursor}&limit=1`,
    );
    assert.deepEqual(
      page.messages.map((m) => m.body),
      ['two'],
    );
    const [, rest] = await get<AuditFeedResponse>(base, watcher, `messages?since=${page.cursor}`);
    assert.deepEqual(
      rest.messages.map((m) => m.body),
      ['three'],
    );

    const [, idle] = await get<AuditFeedResponse>(base, watcher, `messages?since=${rest.cursor}`);
    assert.deepEqual(idle, { messages: [], cursor: rest.cursor, timed_out: true });

    const waiting = get<AuditFeedResponse>(base, watcher, `messages?since=${rest.cursor}&wait_s=5`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await send(base, a, { to: ['b'], body: 'four' });
    const [, woke] = await waiting;
    assert.deepEqual(
      woke.messages.map((m) => m.body),
      ['four'],
    );
    assert.equal(woke.timed_out, false);

    const [unknown] = await get(base, watcher, 'messages?since=msg_nope');
    assert.equal(unknown, 404);
  });
});
