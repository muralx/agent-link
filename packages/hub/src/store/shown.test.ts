import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { AgentStore } from './agents.ts';
import { ConversationStore } from './conversations.ts';
import { MessageStore } from './messages.ts';

function setup() {
  const db = openDatabase(':memory:');
  const agents = new AgentStore(db);
  const conversations = new ConversationStore(db);
  const messages = new MessageStore(db, agents, conversations);
  const reg = (name: string) =>
    agents.register({
      session_id: `s-${name}`,
      name,
      description: `${name} does things`,
      capabilities: 'c',
      workspace: 'w',
      kind: 'agent',
    }).agent;
  return { messages, a: reg('a'), b: reg('b') };
}

test('inbox leaves out what the channel already showed; asking for everything still has it', () => {
  const { messages, a, b } = setup();
  const pushed = messages.send({ fromId: a.id, to: ['b'], body: 'pushed', expectation: 'none' });
  messages.ack(pushed.message_id, b.id, 'notified', 'channel');
  messages.send({ fromId: a.id, to: ['b'], body: 'waiting', expectation: 'none' });
  assert.deepEqual(
    messages.inbox(b.id, { unreadOnly: true, limit: 50 }).map((m) => m.body),
    ['waiting'],
  );
  assert.deepEqual(
    messages.inbox(b.id, { unreadOnly: false, limit: 50 }).map((m) => m.body),
    ['pushed', 'waiting'],
  );
});

test('a hook shows a waiting message once, in full, and never nags about it again', () => {
  const { messages, a, b } = setup();
  const r = messages.send({ fromId: a.id, to: ['b'], body: 'full text', expectation: 'reply' });
  const first = messages.pendingForHook(b.id, '2026-10-20T10:00:00.000Z');
  assert.deepEqual(
    first.map((m) => m.body),
    ['full text'],
  );
  assert.equal(messages.deliveryState(r.message_id, b.id)?.state, 'read');
  assert.equal(messages.deliveryState(r.message_id, b.id)?.via, 'hook');
  assert.deepEqual(messages.pendingForHook(b.id, '2026-10-20T10:05:00.000Z'), []);
  assert.equal(messages.openReplies(b.id).length, 1, 'the question is still open until answered');
});

test('a hook does not repeat what the channel showed', () => {
  const { messages, a, b } = setup();
  const r = messages.send({ fromId: a.id, to: ['b'], body: 'pushed', expectation: 'none' });
  messages.ack(r.message_id, b.id, 'notified', 'channel');
  assert.deepEqual(messages.pendingForHook(b.id, '2026-10-20T10:05:00.000Z'), []);
});

test('the unread count of a conversation counts only what was not shown yet', () => {
  const { messages, a, b } = setup();
  const r = messages.send({ fromId: a.id, to: ['b'], body: 'one', expectation: 'none' });
  messages.ack(r.message_id, b.id, 'notified', 'channel');
  messages.send({
    fromId: a.id,
    conversationId: r.conversation_id,
    body: 'two',
    expectation: 'none',
  });
  const summary = messages.listForAgent(b.id, false)[0];
  assert.equal(summary?.unread, 1);
});
