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
  return { messages, a: reg('a'), b: reg('b'), c: reg('c') };
}

test('an answer marked none still answers the question it follows, once', () => {
  const { messages, a, b } = setup();
  const question = messages.send({ fromId: a.id, to: ['b'], body: 'which?', expectation: 'reply' });
  const answer = messages.send({
    fromId: b.id,
    conversationId: question.conversation_id,
    body: 'this one',
    expectation: 'none',
  });
  assert.deepEqual(answer.answers, [a.id]);
  assert.deepEqual(
    messages.queuedFor(a.id).map((q) => q.answers),
    [[a.id]],
    'the replay knows it too',
  );
  const extra = messages.send({
    fromId: b.id,
    conversationId: question.conversation_id,
    body: 'also, fyi',
    expectation: 'none',
  });
  assert.deepEqual(extra.answers, [], 'the question was already answered');
});

test('updates answer a request for updates until the final one', () => {
  const { messages, a, b } = setup();
  const task = messages.send({ fromId: a.id, to: ['b'], body: 'do it', expectation: 'updates' });
  const progress = messages.send({
    fromId: b.id,
    conversationId: task.conversation_id,
    body: 'half way',
    expectation: 'none',
  });
  assert.deepEqual(progress.answers, [a.id]);
  const done = messages.send({
    fromId: b.id,
    conversationId: task.conversation_id,
    body: 'done',
    expectation: 'none',
    final: true,
  });
  assert.deepEqual(done.answers, [a.id]);
  const after = messages.send({
    fromId: b.id,
    conversationId: task.conversation_id,
    body: 'one more thing',
    expectation: 'none',
  });
  assert.deepEqual(after.answers, []);
});

test('only the participant who asked is answered; a fyi in another conversation answers nothing', () => {
  const { messages, a, b, c } = setup();
  const start = messages.send({
    fromId: a.id,
    to: ['b', 'c'],
    body: 'design?',
    expectation: 'none',
    group: true,
  });
  messages.send({
    fromId: c.id,
    conversationId: start.conversation_id,
    body: 'b, which option?',
    expectation: 'reply',
  });
  const answer = messages.send({
    fromId: b.id,
    conversationId: start.conversation_id,
    body: 'option B',
    expectation: 'none',
  });
  assert.deepEqual(answer.answers, [c.id]);
  const elsewhere = messages.send({ fromId: b.id, to: ['c'], body: 'fyi', expectation: 'none' });
  assert.deepEqual(elsewhere.answers, []);
});
