import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '@agent-link/protocol';
import { AgentStore } from './agents.ts';
import { ConversationStore } from './conversations.ts';
import { openDatabase } from './db.ts';
import { DEFAULT_GUARD_LIMITS, GuardStore, type GuardLimits } from './guard.ts';
import { MessageStore } from './messages.ts';

/** setup builds the stores over a fresh in-memory database. */
function setup(limits: Partial<GuardLimits> = {}): {
  agents: AgentStore;
  messages: MessageStore;
  guard: GuardStore;
  add: (name: string, kind?: 'agent' | 'human') => Agent;
} {
  const db = openDatabase(':memory:');
  const agents = new AgentStore(db);
  const conversations = new ConversationStore(db);
  const messages = new MessageStore(db, agents, conversations);
  const guard = new GuardStore(db, { ...DEFAULT_GUARD_LIMITS, ...limits });
  const add = (name: string, kind: 'agent' | 'human' = 'agent'): Agent =>
    agents.register({
      session_id: `s-${name}`,
      name,
      description: 'd',
      capabilities: 'c',
      workspace: 'w',
      kind,
    }).agent;
  return { agents, messages, guard, add };
}

test('rate rule allows the limit and refuses the next message', () => {
  const { messages, guard, add } = setup({ ratePerMinute: 3 });
  const a = add('a');
  add('b');
  for (let i = 0; i < 3; i++) {
    assert.equal(guard.check(a, { to: ['b'], body: `m${i}` }), undefined);
    messages.send({ fromId: a.id, to: ['b'], body: `m${i}`, expectation: 'none' });
  }
  const violation = guard.check(a, { to: ['b'], body: 'm3' });
  assert.equal(violation?.rule, 'rate');
  assert.match(violation?.detail ?? '', /3 messages in the last minute \(limit 3\)/);
  assert.equal(
    guard.check(a, { to: ['b'], body: 'later' }, Date.now() + 61_000),
    undefined,
    'the window slides',
  );
});

test('repeat rule counts identical bodies from one sender only', () => {
  const { messages, guard, add } = setup({ repeatMax: 2 });
  const a = add('a');
  const b = add('b');
  messages.send({ fromId: a.id, to: ['b'], body: 'same', expectation: 'none' });
  messages.send({ fromId: a.id, to: ['b'], body: 'same', expectation: 'none' });
  assert.equal(guard.check(a, { to: ['b'], body: 'same' })?.rule, 'repeat');
  assert.equal(guard.check(a, { to: ['b'], body: 'different' }), undefined);
  assert.equal(guard.check(b, { to: ['a'], body: 'same' }), undefined);
});

test('broadcast rule counts "*" sends in memory and slides', () => {
  const { guard, add } = setup({ broadcastMax: 2, broadcastWindowMs: 1000 });
  const a = add('a');
  const t = 1_000_000;
  assert.equal(guard.check(a, { to: '*', body: 'x' }, t), undefined);
  assert.equal(guard.check(a, { to: '*', body: 'x' }, t + 1), undefined);
  assert.equal(guard.check(a, { to: '*', body: 'x' }, t + 2)?.rule, 'broadcast');
  assert.equal(guard.check(a, { to: ['b'], body: 'x' }, t + 3), undefined);
  assert.equal(guard.check(a, { to: '*', body: 'x' }, t + 2000), undefined);
});

test('loop rule counts a conversation run since the last human message', () => {
  const { messages, guard, add } = setup({ loopMax: 4 });
  const a = add('a');
  const b = add('b');
  const h = add('h', 'human');
  const first = messages.send({ fromId: a.id, to: ['b', 'h'], body: 'p0', expectation: 'none' });
  const conversationId = first.conversation_id;
  for (let i = 1; i < 4; i++) {
    const from = i % 2 === 0 ? a : b;
    messages.send({ fromId: from.id, conversationId, body: `p${i}`, expectation: 'none' });
  }
  assert.equal(guard.check(a, { body: 'p4', conversationId })?.rule, 'loop');
  assert.equal(guard.check(a, { to: ['b'], body: 'elsewhere' }), undefined);
  messages.send({ fromId: h.id, conversationId, body: 'carry on', expectation: 'none' });
  assert.equal(guard.check(a, { body: 'p4', conversationId }), undefined);
});

test('a human sender is never checked', () => {
  const { messages, guard, add } = setup({ ratePerMinute: 1 });
  const h = add('h', 'human');
  add('b');
  messages.send({ fromId: h.id, to: ['b'], body: '1', expectation: 'none' });
  messages.send({ fromId: h.id, to: ['b'], body: '2', expectation: 'none' });
  assert.equal(guard.check(h, { to: ['b'], body: '3' }), undefined);
});

test('incidents and quarantined listing resolve names; hub incidents are by guard', () => {
  const { agents, guard, add } = setup();
  const a = add('a');
  const h = add('h', 'human');
  agents.setQuarantine(a.id, 'too chatty');
  agents.setQuarantine(a.id, 'second reason is ignored');
  guard.record({
    workspace: 'w',
    agentId: a.id,
    rule: 'rate',
    action: 'quarantined',
    detail: 'too chatty',
  });
  guard.record({
    workspace: 'w',
    agentId: a.id,
    rule: 'manual',
    action: 'released',
    detail: 'ok now',
    byId: h.id,
  });
  const quarantined = guard.quarantined('w');
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0]?.name, 'a');
  assert.equal(quarantined[0]?.reason, 'too chatty');
  assert.equal(agents.byId(a.id)?.quarantined, true);
  const incidents = guard.incidents('w');
  assert.deepEqual(
    incidents.map((i) => [i.agent, i.action, i.by]),
    [
      ['a', 'released', 'h'],
      ['a', 'quarantined', 'guard'],
    ],
  );
  agents.setQuarantine(a.id, null);
  assert.deepEqual(guard.quarantined('w'), []);
  assert.deepEqual(guard.incidents('other'), []);
});

test('the guard name is reserved and the system agent cannot be adopted or reclaimed', () => {
  const { agents, add } = setup();
  const systemId = agents.systemAgent('w');
  assert.equal(agents.systemAgent('w'), systemId, 'created once');
  const impostor = add('guard');
  assert.equal(impostor.name, 'guard-2');
  assert.notEqual(impostor.id, systemId);
  assert.deepEqual(
    agents.peers('w', '').map((p) => p.name),
    ['guard-2'],
  );
  assert.equal(agents.byName('w', 'guard'), undefined);
  assert.equal(agents.findByName('w', 'guard'), undefined);
  assert.throws(
    () =>
      agents.register({
        session_id: 'system:w',
        name: 'x',
        description: 'd',
        capabilities: 'c',
        workspace: 'w',
        kind: 'human',
      }),
    /reserved/,
  );
});

test('adopting an offline name carries a quarantine along', () => {
  const { agents, add } = setup();
  const old = add('worker');
  agents.setOffline(old.id);
  const placeholder = agents.register({
    session_id: 's-new',
    name: 'placeholder',
    description: 'd',
    capabilities: 'c',
    workspace: 'w',
    kind: 'agent',
    provisional: true,
  }).agent;
  agents.setQuarantine(placeholder.id, 'looping');
  const adopted = agents.register({
    session_id: 's-new',
    name: 'worker',
    description: 'd',
    capabilities: 'c',
    workspace: 'w',
    kind: 'agent',
  }).agent;
  assert.equal(adopted.id, old.id);
  assert.equal(adopted.quarantined, true);
});
