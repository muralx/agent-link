import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HubEvent } from '@agent-link/protocol';
import { createHub, type Hub } from './server.ts';

async function withHub(fn: (hub: Hub, base: string) => Promise<void>) {
  const hub = createHub({ dbPath: ':memory:', port: 0 });
  const url = await hub.listen();
  try {
    await fn(hub, url);
  } finally {
    await hub.close();
  }
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const reg = (session_id: string, name: string, workspace = 'w') => ({
  session_id,
  name,
  description: `${name} does things`,
  capabilities: 'consult',
  workspace,
  kind: 'agent',
  cwd: '/repo',
});

async function register(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/v1/agents`, { method: 'POST', body: JSON.stringify(body) });
  return {
    status: res.status,
    data: await json<{
      agent: { id: string; name: string };
      token: string;
      peers: { name: string }[];
      error?: string;
    }>(res),
  };
}

test('health answers without auth', async () => {
  await withHub(async (_hub, base) => {
    const res = await fetch(`${base}/v1/health`);
    assert.equal(res.status, 200);
    const body = await json<{ ok: boolean; version: string; pid: number }>(res);
    assert.equal(body.ok, true);
    assert.equal(body.pid, process.pid);
  });
});

test('sessions are upserted and report their agent once registered', async () => {
  await withHub(async (_hub, base) => {
    const r1 = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 's1', cwd: '/repo', workspace_hint: 'w' }),
    });
    assert.equal(r1.status, 200);
    assert.equal((await json<{ agent: unknown }>(r1)).agent, null);
    const { status, data } = await register(base, {
      ...reg('s1', 'architect'),
      workspace: undefined,
    });
    assert.equal(status, 201, JSON.stringify(data));
    assert.equal(data.agent.name, 'architect');
    const r2 = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 's1' }),
    });
    assert.equal((await json<{ agent: { id: string } }>(r2)).agent.id, data.agent.id);
  });
});

test('register needs a workspace from the body or the session hint', async () => {
  await withHub(async (_hub, base) => {
    const { status, data } = await register(base, { ...reg('s9', 'x'), workspace: undefined });
    assert.equal(status, 400);
    assert.equal(data.error, 'workspace_required');
    const bad = await register(base, { name: 'x' });
    assert.equal(bad.status, 400);
  });
});

test('register reclaims by session and peers are workspace-scoped and authenticated', async () => {
  await withHub(async (_hub, base) => {
    const a = await register(base, reg('sa', 'architect'));
    const b = await register(base, reg('sb', 'designer'));
    const c = await register(base, reg('sc', 'stranger', 'other'));
    assert.deepEqual(a.data.peers, []);
    assert.equal(b.data.peers[0]?.name, 'architect');

    const again = await register(base, { ...reg('sa', 'architect'), description: 'new' });
    assert.equal(again.data.agent.id, a.data.agent.id);
    assert.equal(again.data.agent.name, 'architect');

    const peers = await fetch(`${base}/v1/workspaces/w/agents`, {
      headers: { authorization: `Bearer ${again.data.token}` },
    });
    assert.equal(peers.status, 200);
    assert.deepEqual(
      (await json<{ name: string }[]>(peers)).map((p) => p.name),
      ['designer'],
    );

    const stale = await fetch(`${base}/v1/workspaces/w/agents`, {
      headers: { authorization: `Bearer ${a.data.token}` },
    });
    assert.equal(stale.status, 401);
    const foreign = await fetch(`${base}/v1/workspaces/w/agents`, {
      headers: { authorization: `Bearer ${c.data.token}` },
    });
    assert.equal(foreign.status, 403);
    const anon = await fetch(`${base}/v1/workspaces/w/agents`);
    assert.equal(anon.status, 401);
  });
});

test('unregister and session end take agents offline and emit peer events', async () => {
  await withHub(async (hub, base) => {
    const a = await register(base, reg('sa', 'architect'));
    const events: HubEvent[] = [];
    hub.bus.subscribe(a.data.agent.id, (e) => events.push(e));
    const b = await register(base, reg('sb', 'designer'));
    assert.deepEqual(
      events.map((e) => (e.type === 'peer' ? `${e.event}:${e.name}` : e.type)),
      ['joined:designer'],
    );

    const wrong = await fetch(`${base}/v1/agents/${b.data.agent.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${a.data.token}` },
    });
    assert.equal(wrong.status, 403);
    const del = await fetch(`${base}/v1/agents/${b.data.agent.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${b.data.token}` },
    });
    assert.equal(del.status, 204);
    assert.equal(events.length, 2);
    assert.equal(hub.stores.agents.byId(b.data.agent.id)?.status, 'offline');

    const back = await register(base, reg('sb', 'designer'));
    assert.equal(back.data.agent.id, b.data.agent.id);
    const end = await fetch(`${base}/v1/sessions/sb/end`, { method: 'POST' });
    assert.equal(end.status, 204);
    assert.equal(hub.stores.agents.byId(b.data.agent.id)?.status, 'offline');
    const endUnknown = await fetch(`${base}/v1/sessions/nope/end`, { method: 'POST' });
    assert.equal(endUnknown.status, 204);
  });
});

test('session pending and open routes are safe for unknown sessions', async () => {
  await withHub(async (_hub, base) => {
    const pending = await fetch(`${base}/v1/sessions/unknown/pending`);
    assert.equal(pending.status, 200);
    assert.deepEqual(await pending.json(), { agent: null, messages: [], open_replies: [] });
    const open = await fetch(`${base}/v1/sessions/unknown/open`);
    assert.deepEqual(await open.json(), { agent: null, open_replies: [] });
    await register(base, reg('sa', 'architect'));
    const known = await fetch(`${base}/v1/sessions/sa/open`);
    assert.deepEqual(await known.json(), {
      agent: { name: 'architect', kind: 'agent', provisional: false },
      open_replies: [],
    });
  });
});

test("register with agent_id needs that agent's token and upgrades it whatever its session is now", async () => {
  await withHub(async (hub, base) => {
    const placeholder = await register(base, {
      ...reg('s-old', 'repo'),
      provisional: true,
      window: 'win-1',
    });
    hub.stores.agents.relinkSession(placeholder.data.agent.id, 's-new');
    const forged = await fetch(`${base}/v1/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: JSON.stringify({ ...reg('s-old', 'architect'), agent_id: placeholder.data.agent.id }),
    });
    assert.equal(forged.status, 401);
    const other = await register(base, reg('s-x', 'other'));
    const stolen = await fetch(`${base}/v1/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${other.data.token}` },
      body: JSON.stringify({ ...reg('s-old', 'architect'), agent_id: placeholder.data.agent.id }),
    });
    assert.equal(stolen.status, 403);
    const upgraded = await fetch(`${base}/v1/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${placeholder.data.token}` },
      body: JSON.stringify({ ...reg('s-old', 'architect'), agent_id: placeholder.data.agent.id }),
    });
    assert.equal(upgraded.status, 201);
    const body = await json<{ agent: { id: string; name: string; provisional: boolean } }>(
      upgraded,
    );
    assert.equal(body.agent.id, placeholder.data.agent.id);
    assert.equal(body.agent.name, 'architect');
    assert.equal(body.agent.provisional, false);
  });
});
