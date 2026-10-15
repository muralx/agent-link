import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { AgentStore } from './agents.ts';
import { ConversationStore } from './conversations.ts';

function setup() {
  const db = openDatabase(':memory:');
  const agents = new AgentStore(db);
  const conversations = new ConversationStore(db);
  const reg = (name: string) =>
    agents.register({
      session_id: `s-${name}`,
      name,
      description: 'd',
      capabilities: 'c',
      workspace: 'w',
      kind: 'agent',
    }).agent;
  return { db, agents, conversations, a: reg('a'), b: reg('b'), c: reg('c') };
}

test('create stores the header and the participants', () => {
  const { conversations, a, b } = setup();
  const conv = conversations.create({
    workspace: 'w',
    createdBy: a.id,
    subject: 'Caching',
    participantIds: [a.id, b.id],
  });
  assert.match(conv.id, /^cv_/);
  assert.equal(conv.subject, 'Caching');
  assert.deepEqual(
    conversations.participants(conv.id).map((p) => p.name),
    ['a', 'b'],
  );
  assert.equal(conversations.isParticipant(conv.id, a.id), true);
  assert.equal(conversations.get(conv.id)?.created_by, a.id);
  assert.equal(conversations.get('cv_missing'), undefined);
});

test('addParticipants ignores agents already present', () => {
  const { conversations, a, b, c } = setup();
  const conv = conversations.create({
    workspace: 'w',
    createdBy: a.id,
    subject: null,
    participantIds: [a.id, b.id],
  });
  conversations.addParticipants(conv.id, [b.id, c.id]);
  conversations.addParticipants(conv.id, [c.id]);
  assert.deepEqual(conversations.participantIds(conv.id).sort(), [a.id, b.id, c.id].sort());
});
