import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { SessionStore } from './sessions.ts';
import { AgentStore } from './agents.ts';

test('upsert keeps earlier values when later calls omit them', () => {
  const db = openDatabase(':memory:');
  const s = new SessionStore(db);
  const first = s.upsert({ session_id: 'x', cwd: '/repo', workspace_hint: 'w' });
  assert.equal(first.agent_id, null);
  const again = s.upsert({ session_id: 'x', window: 'win-1' });
  assert.equal(again.cwd, '/repo');
  assert.equal(again.workspace_hint, 'w');
  assert.equal(again.window, 'win-1');
  assert.equal(s.upsert({ session_id: 'x' }).window, 'win-1');
  assert.equal(s.get('missing'), undefined);
});

test('linkAgent records which agent a session registered', () => {
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const agents = new AgentStore(db);
  sessions.upsert({ session_id: 'x' });
  const { agent } = agents.register({
    session_id: 'x',
    name: 'a',
    description: 'd',
    capabilities: 'c',
    workspace: 'w',
    kind: 'agent',
  });
  sessions.linkAgent('x', agent.id);
  assert.equal(sessions.get('x')?.agent_id, agent.id);
});
