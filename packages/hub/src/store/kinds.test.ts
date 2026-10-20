import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
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
  return { db, agents, conversations, messages, a: reg('a'), b: reg('b'), c: reg('c') };
}

function recipients(db: DatabaseSync, messageId: string): string[] {
  const rows = db
    .prepare(
      'SELECT a.name FROM delivery d JOIN agent a ON a.id = d.to_agent WHERE d.message_id = ? ORDER BY a.name',
    )
    .all(messageId) as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

test('the first send fixes the kind: one recipient direct, several or * announcement, group on request', () => {
  const { messages, conversations, a } = setup();
  const direct = messages.send({ fromId: a.id, to: ['b'], body: 'x', expectation: 'none' });
  const several = messages.send({ fromId: a.id, to: ['b', 'c'], body: 'x', expectation: 'none' });
  const all = messages.send({ fromId: a.id, to: '*', body: 'x', expectation: 'none' });
  const group = messages.send({
    fromId: a.id,
    to: ['b', 'c'],
    body: 'x',
    expectation: 'none',
    group: true,
  });
  assert.equal(conversations.get(direct.conversation_id)?.kind, 'direct');
  assert.equal(conversations.get(several.conversation_id)?.kind, 'announcement');
  assert.equal(conversations.get(all.conversation_id)?.kind, 'announcement');
  assert.equal(conversations.get(group.conversation_id)?.kind, 'group');
  assert.equal(several.kind, 'announcement');
});

test('in an announcement a reply reaches only the starter, and the starter reaches everyone', () => {
  const { messages, db, a, b } = setup();
  const start = messages.send({ fromId: a.id, to: '*', body: 'pull', expectation: 'reply' });
  const answer = messages.send({
    fromId: b.id,
    conversationId: start.conversation_id,
    body: 'pulled',
    expectation: 'none',
  });
  assert.deepEqual(recipients(db, answer.message_id), ['a']);
  assert.deepEqual(answer.delivered_to, ['a']);
  assert.deepEqual(answer.message.to, ['a']);
  const followUp = messages.send({
    fromId: a.id,
    conversationId: start.conversation_id,
    body: 'thanks, all done',
    expectation: 'none',
  });
  assert.deepEqual(recipients(db, followUp.message_id), ['b', 'c']);
});

test('in a group every reply reaches every other participant', () => {
  const { messages, db, a, b } = setup();
  const start = messages.send({
    fromId: a.id,
    to: ['b', 'c'],
    body: 'design?',
    expectation: 'reply',
    group: true,
  });
  const answer = messages.send({
    fromId: b.id,
    conversationId: start.conversation_id,
    body: 'option B',
    expectation: 'none',
  });
  assert.deepEqual(recipients(db, answer.message_id), ['a', 'c']);
});

test('adding a participant to a direct conversation turns it into a group', () => {
  const { messages, conversations, db, a, b } = setup();
  const start = messages.send({ fromId: a.id, to: ['b'], body: 'x', expectation: 'none' });
  messages.send({
    fromId: a.id,
    conversationId: start.conversation_id,
    to: ['c'],
    body: 'c joins',
    expectation: 'none',
  });
  assert.equal(conversations.get(start.conversation_id)?.kind, 'group');
  const answer = messages.send({
    fromId: b.id,
    conversationId: start.conversation_id,
    body: 'hi c',
    expectation: 'none',
  });
  assert.deepEqual(recipients(db, answer.message_id), ['a', 'c']);
});

test('a participant sees only the messages it sent or received', () => {
  const { messages, a, b, c } = setup();
  const start = messages.send({ fromId: a.id, to: '*', body: 'pull', expectation: 'reply' });
  messages.send({
    fromId: b.id,
    conversationId: start.conversation_id,
    body: 'b pulled',
    expectation: 'none',
  });
  messages.send({
    fromId: c.id,
    conversationId: start.conversation_id,
    body: 'c pulled',
    expectation: 'none',
  });
  const forC = messages.thread(c.id, start.conversation_id).messages.map((m) => m.body);
  assert.deepEqual(forC, ['pull', 'c pulled']);
  const forA = messages.thread(a.id, start.conversation_id).messages.map((m) => m.body);
  assert.deepEqual(forA, ['pull', 'b pulled', 'c pulled']);
});

test('conversation summaries carry the kind', () => {
  const { messages, a, b } = setup();
  const start = messages.send({ fromId: a.id, to: ['b', 'c'], body: 'x', expectation: 'none' });
  const summary = messages.listForAgent(b.id, false).find((s) => s.id === start.conversation_id);
  assert.equal(summary?.kind, 'announcement');
});
