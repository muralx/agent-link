import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { AgentStore } from './agents.ts';

function store(): AgentStore {
  return new AgentStore(openDatabase(':memory:'));
}

const profile = {
  session_id: 's-architect',
  name: 'architect',
  description: 'Designs the system',
  capabilities: 'consult, resolve',
  workspace: 'w',
  kind: 'agent' as const,
};

test('register creates an online agent and a token that resolves to it', () => {
  const s = store();
  const { agent, token } = s.register(profile);
  assert.match(agent.id, /^ag_/);
  assert.equal(agent.status, 'online');
  assert.equal(agent.name, 'architect');
  assert.equal(s.byToken(token)?.id, agent.id);
  assert.equal(s.byToken('nope'), undefined);
  assert.equal(s.bySession('s-architect')?.id, agent.id);
});

test('a name taken by an online agent in the workspace gets a suffix', () => {
  const s = store();
  s.register(profile);
  const second = s.register({ ...profile, session_id: 's2' }).agent;
  assert.equal(second.name, 'architect-2');
  const third = s.register({ ...profile, session_id: 's3' }).agent;
  assert.equal(third.name, 'architect-3');
  const elsewhere = s.register({ ...profile, session_id: 's4', workspace: 'other' }).agent;
  assert.equal(elsewhere.name, 'architect');
});

test('registering again with the same session reclaims the agent', () => {
  const s = store();
  const first = s.register(profile);
  s.setOffline(first.agent.id);
  const again = s.register({ ...profile, description: 'Designs everything' });
  assert.equal(again.agent.id, first.agent.id);
  assert.equal(again.agent.name, 'architect');
  assert.equal(again.agent.status, 'online');
  assert.equal(again.agent.description, 'Designs everything');
  assert.notEqual(again.token, first.token);
  assert.equal(s.byToken(first.token), undefined);
  assert.equal(s.byToken(again.token)?.id, first.agent.id);
});

test('an offline agent is adopted by the next registration under its name; the original session returning gets the suffix', () => {
  const s = store();
  const first = s.register(profile);
  s.setOffline(first.agent.id);
  const taken = s.register({ ...profile, session_id: 's-other' });
  assert.equal(taken.agent.id, first.agent.id, 'the name is the identity in the workspace');
  assert.equal(taken.previous?.status, 'offline');
  const again = s.register(profile);
  assert.notEqual(again.agent.id, first.agent.id);
  assert.equal(again.agent.name, 'architect-2');
});

test('peers lists online agents of the workspace except the caller', () => {
  const s = store();
  const a = s.register(profile).agent;
  const b = s.register({ ...profile, session_id: 'sb', name: 'designer' }).agent;
  s.register({ ...profile, session_id: 'sc', name: 'stranger', workspace: 'other' });
  assert.deepEqual(
    s.peers('w', a.id).map((p) => p.name),
    ['designer'],
  );
  s.setOffline(b.id);
  assert.deepEqual(s.peers('w', a.id), []);
  assert.equal(s.byId(b.id)?.status, 'offline');
  const reused = s.register({ ...profile, session_id: 'sd', name: 'designer' }).agent;
  assert.equal(reused.name, 'designer');
});

test('byName resolves only online agents in the workspace', () => {
  const s = store();
  const a = s.register(profile).agent;
  assert.equal(s.byName('w', 'architect')?.id, a.id);
  assert.equal(s.byName('other', 'architect'), undefined);
  s.setOffline(a.id);
  assert.equal(s.byName('w', 'architect'), undefined);
});

test('touch bumps last_seen', async () => {
  const s = store();
  const a = s.register(profile).agent;
  await new Promise((r) => setTimeout(r, 5));
  s.touch(a.id);
  assert.ok((s.byId(a.id)?.last_seen ?? '') > a.last_seen);
});

test('a provisional registration reconnects an existing agent without touching its profile', () => {
  const s = store();
  const first = s.register({ ...profile, window: 'win-1' });
  assert.equal(first.agent.provisional, false);
  assert.equal(first.agent.window, 'win-1');
  s.setOffline(first.agent.id);

  const back = s.register({
    session_id: 's-architect',
    name: 'agent-link',
    description: 'not identified yet',
    capabilities: 'unknown',
    workspace: 'w',
    kind: 'agent',
    provisional: true,
    window: 'win-2',
  });
  assert.equal(back.agent.id, first.agent.id, 'same session reclaims');
  assert.equal(back.agent.name, 'architect', 'the identity survives a provisional reconnect');
  assert.equal(back.agent.description, 'Designs the system');
  assert.equal(back.agent.provisional, false);
  assert.equal(back.agent.window, 'win-2');
  assert.equal(back.previous?.status, 'offline');

  const fresh = s.register({ ...profile, session_id: 's-new', name: 'proj', provisional: true });
  assert.equal(fresh.agent.provisional, true);
  assert.equal(fresh.previous, undefined);
  const identified = s.register({ ...profile, session_id: 's-new', name: 'designer' });
  assert.equal(identified.agent.id, fresh.agent.id);
  assert.equal(identified.agent.provisional, false);
  assert.equal(identified.agent.name, 'designer');
  assert.equal(identified.previous?.name, 'proj');
});

test('a window finds its agent across session ids and relinkSession follows a switch', () => {
  const s = store();
  const a = s.register({ ...profile, window: 'win-1' }).agent;
  assert.equal(s.byWindow('win-1')?.id, a.id);
  assert.equal(s.byWindow('nope'), undefined);

  const sameWindow = s.register({
    ...profile,
    session_id: 's-after-clear',
    name: 'proj',
    provisional: true,
    window: 'win-1',
  });
  assert.equal(sameWindow.agent.id, a.id, 'a restarted edge in the same window reclaims');
  assert.equal(sameWindow.agent.session_id, 's-after-clear');
  assert.equal(sameWindow.agent.name, 'architect');

  s.relinkSession(a.id, 's-resumed');
  assert.equal(s.bySession('s-resumed')?.id, a.id);
  assert.equal(s.bySession('s-after-clear'), undefined);
});

test('register with agent_id upgrades that agent even after its session was relinked', () => {
  const s = store();
  const placeholder = s.register({
    ...profile,
    name: 'repo',
    session_id: 's-old',
    provisional: true,
    window: 'win-1',
  });
  s.relinkSession(placeholder.agent.id, 's-new'); // a hook followed the window to another session
  const upgraded = s.register({ ...profile, session_id: 's-old', agent_id: placeholder.agent.id });
  assert.equal(upgraded.agent.id, placeholder.agent.id, 'same agent, not a second one');
  assert.equal(upgraded.agent.name, 'architect');
  assert.equal(upgraded.agent.provisional, false);
  assert.equal(upgraded.previous?.name, 'repo');
  assert.equal(s.byToken(placeholder.token), undefined, 'the old token is gone');
  assert.equal(s.byToken(upgraded.token)?.id, placeholder.agent.id);
});

test('an identified registration adopts the offline agent of the same name and absorbs the placeholder', () => {
  const db = openDatabase(':memory:');
  const s = new AgentStore(db);
  const human = s.register({ ...profile, name: 'alice', kind: 'human', session_id: 's-relay-1' });
  const asker = s.register({ ...profile, name: 'architect', session_id: 's-arch' });
  // a conversation the human was asked in, with a delivery still waiting
  db.prepare(
    "INSERT INTO conversation (id, workspace, subject, created_by, created_at) VALUES ('cv_1','w',NULL,?, 't')",
  ).run(asker.agent.id);
  db.prepare(
    "INSERT INTO participant (conversation_id, agent_id, joined_at) VALUES ('cv_1',?, 't'), ('cv_1',?, 't')",
  ).run(asker.agent.id, human.agent.id);
  db.prepare(
    "INSERT INTO message (id, conversation_id, from_agent, to_names, body, expectation, final, in_reply_to, created_at) VALUES ('msg_1','cv_1',?,'[\"alice\"]','ok?','reply',0,NULL,'t')",
  ).run(asker.agent.id);
  db.prepare(
    "INSERT INTO delivery (message_id, to_agent, state) VALUES ('msg_1', ?, 'queued')",
  ).run(human.agent.id);
  s.setOffline(human.agent.id);

  // a new window: the edge registers a placeholder, then the relay identifies as alice again
  const placeholder = s.register({
    ...profile,
    name: 'repo',
    session_id: 's-relay-2',
    provisional: true,
    window: 'win-2',
  });
  db.prepare(
    "INSERT INTO participant (conversation_id, agent_id, joined_at) VALUES ('cv_1',?, 't')",
  ).run(placeholder.agent.id); // overlapping membership is dropped, not duplicated
  const back = s.register({
    ...profile,
    name: 'alice',
    kind: 'human',
    session_id: 's-relay-2',
    agent_id: placeholder.agent.id,
    window: 'win-2',
  });
  assert.equal(back.agent.id, human.agent.id, 'the old mailbox owner is back');
  assert.equal(back.agent.status, 'online');
  assert.equal(back.agent.window, 'win-2');
  assert.equal(back.agent.provisional, false);
  assert.equal(back.previous?.id, placeholder.agent.id, 'previous is the absorbed placeholder');
  assert.equal(s.byId(placeholder.agent.id), undefined, 'placeholder row is gone');
  assert.equal(s.bySession('s-relay-2')?.id, human.agent.id);
  const delivery = db
    .prepare("SELECT to_agent, state FROM delivery WHERE message_id = 'msg_1'")
    .get() as { to_agent: string; state: string };
  assert.equal(delivery.to_agent, human.agent.id);
  assert.equal(delivery.state, 'queued', 'the waiting message is still waiting for alice');
  const members = db
    .prepare("SELECT agent_id FROM participant WHERE conversation_id = 'cv_1' ORDER BY agent_id")
    .all()
    .map((r) => (r as { agent_id: string }).agent_id)
    .sort();
  assert.deepEqual(members, [asker.agent.id, human.agent.id].sort());
});

test('adoption needs an offline, identified namesake; online or provisional ones get the usual suffix', () => {
  const s = store();
  const online = s.register({ ...profile, session_id: 's1' });
  const second = s.register({ ...profile, session_id: 's2' });
  assert.equal(second.agent.name, 'architect-2', 'online namesake is not adopted');
  assert.notEqual(second.agent.id, online.agent.id);
  const stale = s.register({ ...profile, name: 'repo', session_id: 's3', provisional: true });
  s.setOffline(stale.agent.id);
  const fresh = s.register({ ...profile, name: 'repo', session_id: 's4' });
  assert.notEqual(fresh.agent.id, stale.agent.id, 'an offline placeholder is not adopted');
  const renamed = s.register({ ...profile, session_id: 's1', name: 'lead' });
  assert.equal(
    renamed.agent.id,
    online.agent.id,
    'an identified agent renaming itself stays itself',
  );
});
