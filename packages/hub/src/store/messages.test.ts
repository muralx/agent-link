import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { AgentStore } from './agents.ts';
import { ConversationStore } from './conversations.ts';
import { MessageStore } from './messages.ts';
import { HubError } from './errors.ts';

function setup() {
  const db = openDatabase(':memory:');
  const agents = new AgentStore(db);
  const conversations = new ConversationStore(db);
  const messages = new MessageStore(db, agents, conversations);
  const reg = (name: string, workspace = 'w') =>
    agents.register({
      session_id: `s-${name}`,
      name,
      description: `${name} does things`,
      capabilities: 'c',
      workspace,
      kind: 'agent',
    }).agent;
  return {
    db,
    agents,
    conversations,
    messages,
    a: reg('a'),
    b: reg('b'),
    c: reg('c'),
    d: reg('d', 'other'),
  };
}

function fails(fn: () => unknown, code: string): HubError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HubError, `expected HubError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail('expected a HubError');
}

test('send to one peer starts a conversation with a queued delivery', () => {
  const { messages, conversations, a, b } = setup();
  const r = messages.send({
    fromId: a.id,
    to: ['b'],
    body: 'How should we cache?',
    expectation: 'reply',
    subject: 'Caching',
  });
  assert.match(r.message_id, /^msg_/);
  assert.deepEqual(r.delivered_to, ['b']);
  assert.deepEqual(r.offline, []);
  assert.deepEqual(
    conversations.participants(r.conversation_id).map((p) => p.name),
    ['a', 'b'],
  );
  assert.equal(r.message.from, 'a');
  assert.deepEqual(r.message.to, ['b']);
  assert.equal(r.message.in_reply_to, null);
  assert.deepEqual(r.recipientIds, [b.id]);
  assert.equal(messages.deliveryState(r.message_id, b.id)?.state, 'queued');
});

test('broadcast reaches every online peer of the workspace only', () => {
  const { messages, a } = setup();
  const r = messages.send({ fromId: a.id, to: '*', body: 'hello all', expectation: 'none' });
  assert.deepEqual(r.delivered_to.sort(), ['b', 'c']);
});

test('naming an unknown or foreign peer fails without writing anything', () => {
  const { messages, a, db } = setup();
  const err = fails(
    () => messages.send({ fromId: a.id, to: ['d'], body: 'x', expectation: 'none' }),
    'peer_not_found',
  );
  assert.deepEqual((err.extra as { online: string[] }).online, ['b', 'c']);
  fails(
    () => messages.send({ fromId: a.id, to: ['b', 'zzz'], body: 'x', expectation: 'none' }),
    'peer_not_found',
  );
  const count = db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number };
  assert.equal(count.n, 0);
});

test('a reply goes to the other participants, sets in_reply_to and marks earlier messages read', () => {
  const { messages, a, b } = setup();
  const q = messages.send({ fromId: a.id, to: ['b'], body: 'question', expectation: 'reply' });
  const r = messages.send({
    fromId: b.id,
    conversationId: q.conversation_id,
    body: 'answer',
    expectation: 'none',
  });
  assert.deepEqual(r.delivered_to, ['a']);
  assert.equal(r.message.in_reply_to, q.message_id);
  assert.equal(r.message.to[0], 'a');
  const d = messages.deliveryState(q.message_id, b.id);
  assert.equal(d?.state, 'read');
  assert.equal(d?.via, 'reply');
  assert.deepEqual(messages.openReplies(b.id), []);
});

test('an explicit in_reply_to wins over the rule', () => {
  const { messages, a, b } = setup();
  const q1 = messages.send({ fromId: a.id, to: ['b'], body: 'q1', expectation: 'reply' });
  messages.send({
    fromId: a.id,
    conversationId: q1.conversation_id,
    body: 'q2',
    expectation: 'none',
  });
  const r = messages.send({
    fromId: b.id,
    conversationId: q1.conversation_id,
    body: 'a1',
    expectation: 'none',
    inReplyTo: q1.message_id,
  });
  assert.equal(r.message.in_reply_to, q1.message_id);
});

test('a reply to an offline participant is written and recorded as offline', () => {
  const { messages, agents, a, b } = setup();
  const q = messages.send({ fromId: a.id, to: ['b'], body: 'question', expectation: 'reply' });
  agents.setOffline(a.id);
  const r = messages.send({
    fromId: b.id,
    conversationId: q.conversation_id,
    body: 'answer',
    expectation: 'none',
  });
  assert.deepEqual(r.delivered_to, []);
  assert.deepEqual(r.offline, ['a']);
  assert.equal(messages.deliveryState(r.message_id, a.id)?.state, 'queued');
});

test('sending into a conversation can add online participants; existing ones are a no-op', () => {
  const { messages, conversations, a, b } = setup();
  const q = messages.send({ fromId: a.id, to: ['b'], body: 'q', expectation: 'none' });
  const r = messages.send({
    fromId: a.id,
    conversationId: q.conversation_id,
    to: ['c', 'b'],
    body: 'adding c',
    expectation: 'none',
  });
  assert.deepEqual(r.delivered_to.sort(), ['b', 'c']);
  assert.equal(conversations.participantIds(q.conversation_id).length, 3);
  const later = messages.send({
    fromId: b.id,
    conversationId: q.conversation_id,
    body: 'hi c',
    expectation: 'none',
  });
  assert.deepEqual(later.delivered_to.sort(), ['a', 'c']);
  fails(
    () =>
      messages.send({
        fromId: a.id,
        conversationId: q.conversation_id,
        to: ['d'],
        body: 'x',
        expectation: 'none',
      }),
    'peer_not_found',
  );
});

test('only participants may post into a conversation', () => {
  const { messages, a, c } = setup();
  const q = messages.send({ fromId: a.id, to: ['b'], body: 'q', expectation: 'none' });
  fails(
    () =>
      messages.send({
        fromId: c.id,
        conversationId: q.conversation_id,
        body: 'intrude',
        expectation: 'none',
      }),
    'not_participant',
  );
  fails(
    () =>
      messages.send({ fromId: a.id, conversationId: 'cv_missing', body: 'x', expectation: 'none' }),
    'not_found',
  );
});

test('inbox returns unread messages and marks them read', () => {
  const { messages, a, b } = setup();
  messages.send({ fromId: a.id, to: ['b'], body: 'one', expectation: 'none' });
  messages.send({ fromId: a.id, to: ['b'], body: 'two', expectation: 'none' });
  const first = messages.inbox(b.id, { unreadOnly: true, limit: 50 });
  assert.deepEqual(
    first.map((m) => m.body),
    ['one', 'two'],
  );
  assert.deepEqual(messages.inbox(b.id, { unreadOnly: true, limit: 50 }), []);
  assert.equal(messages.inbox(b.id, { unreadOnly: false, limit: 1 }).length, 1);
  assert.equal(messages.deliveryState(first[0]!.id, b.id)?.via, 'inbox');
});

test('open expectations are derived from who posted after whom', () => {
  const { messages, a, b } = setup();
  const q = messages.send({ fromId: a.id, to: ['b'], body: 'q', expectation: 'reply' });
  const u = messages.send({
    fromId: b.id,
    to: ['a'],
    body: 'I will keep you posted',
    expectation: 'updates',
  });
  assert.deepEqual(
    messages.openReplies(b.id).map((o) => o.message_id),
    [q.message_id],
  );
  assert.deepEqual(messages.openReplies(a.id), []);
  assert.deepEqual(
    messages.openUpdates(a.id).map((o) => o.message_id),
    [u.message_id],
  );
  messages.send({
    fromId: a.id,
    conversationId: u.conversation_id,
    body: 'progress',
    expectation: 'none',
  });
  assert.equal(messages.openUpdates(a.id).length, 1);
  messages.send({
    fromId: a.id,
    conversationId: u.conversation_id,
    body: 'done',
    expectation: 'none',
    final: true,
  });
  assert.equal(messages.openUpdates(a.id).length, 0);
  messages.send({
    fromId: b.id,
    conversationId: q.conversation_id,
    body: 'answer',
    expectation: 'none',
  });
  assert.deepEqual(messages.openReplies(b.id), []);
});

test('unreadFor narrows by conversation or by messages after a given one', () => {
  const { messages, a, b } = setup();
  const q1 = messages.send({ fromId: a.id, to: ['b'], body: 'q1', expectation: 'reply' });
  const q2 = messages.send({ fromId: a.id, to: ['b'], body: 'q2', expectation: 'reply' });
  assert.equal(messages.unreadFor(b.id, {}).length, 2);
  assert.deepEqual(
    messages.unreadFor(b.id, { conversationId: q2.conversation_id }).map((m) => m.body),
    ['q2'],
  );
  const ans = messages.send({
    fromId: b.id,
    conversationId: q1.conversation_id,
    body: 'a1',
    expectation: 'none',
  });
  assert.deepEqual(
    messages.unreadFor(a.id, { afterMessageId: q1.message_id }).map((m) => m.id),
    [ans.message_id],
  );
  assert.deepEqual(messages.unreadFor(a.id, { afterMessageId: ans.message_id }), []);
});

test('listForAgent summarises unread counts and what is open for me', () => {
  const { messages, a, b } = setup();
  const q = messages.send({
    fromId: a.id,
    to: ['b'],
    body: 'q',
    expectation: 'reply',
    subject: 'S',
  });
  messages.send({ fromId: b.id, to: ['a'], body: 'fyi', expectation: 'none' });
  const forB = messages.listForAgent(b.id, false);
  assert.equal(forB.length, 2);
  const s = forB.find((x) => x.id === q.conversation_id)!;
  assert.equal(s.subject, 'S');
  assert.equal(s.unread, 1);
  assert.deepEqual(s.participants, ['a', 'b']);
  assert.equal(s.open_for_me[0]?.message_id, q.message_id);
  assert.equal(messages.listForAgent(b.id, true).length, 1);
  assert.equal(messages.listForAgent(a.id, true).length, 0);
});

test('thread returns messages in order, optionally after a message, and marks only those read', () => {
  const { messages, a, b } = setup();
  const q1 = messages.send({ fromId: a.id, to: ['b'], body: 'q1', expectation: 'none' });
  const q2 = messages.send({
    fromId: a.id,
    conversationId: q1.conversation_id,
    body: 'q2',
    expectation: 'none',
  });
  const part = messages.thread(b.id, q1.conversation_id, q1.message_id);
  assert.deepEqual(
    part.messages.map((m) => m.id),
    [q2.message_id],
  );
  assert.equal(messages.deliveryState(q1.message_id, b.id)?.state, 'queued');
  assert.equal(messages.deliveryState(q2.message_id, b.id)?.state, 'read');
  const all = messages.thread(b.id, q1.conversation_id);
  assert.equal(all.messages.length, 2);
  assert.deepEqual(all.participants, ['a', 'b']);
  fails(() => messages.thread(a.id, 'cv_missing'), 'not_found');
});

test('ack transitions queued to notified and anything to read, never backwards', () => {
  const { messages, a, b } = setup();
  const m = messages.send({ fromId: a.id, to: ['b'], body: 'q', expectation: 'none' });
  messages.ack(m.message_id, b.id, 'notified', 'channel');
  assert.equal(messages.deliveryState(m.message_id, b.id)?.via, 'channel');
  messages.ack(m.message_id, b.id, 'read', 'inbox');
  messages.ack(m.message_id, b.id, 'notified', 'hook');
  assert.equal(messages.deliveryState(m.message_id, b.id)?.state, 'read');
  assert.deepEqual(messages.queuedFor(b.id), []);
});

test('queuedFor returns undelivered messages with their event context', () => {
  const { messages, a, b } = setup();
  const m = messages.send({
    fromId: a.id,
    to: ['b'],
    body: 'q',
    expectation: 'none',
    subject: 'S',
  });
  const q = messages.queuedFor(b.id);
  assert.equal(q.length, 1);
  assert.equal(q[0]?.message.id, m.message_id);
  assert.equal(q[0]?.subject, 'S');
  assert.deepEqual(q[0]?.participants, ['a', 'b']);
});
