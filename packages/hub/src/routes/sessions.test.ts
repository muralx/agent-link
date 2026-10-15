import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionUpsertResponse } from '@agent-link/protocol';
import { openStream, registerAgent, withHub } from './testkit.ts';

async function upsert(base: string, body: Record<string, unknown>): Promise<SessionUpsertResponse> {
  const res = await fetch(`${base}/v1/sessions`, { method: 'POST', body: JSON.stringify(body) });
  return (await res.json()) as SessionUpsertResponse;
}

test('a window that switches sessions keeps its agent and the hooks follow it', async () => {
  await withHub(async (hub, base) => {
    const a = await registerAgent(base, 'architect');
    hub.stores.agents.register({
      session_id: 's-architect',
      name: 'architect',
      description: 'architect does things',
      capabilities: 'consult',
      workspace: 'w',
      kind: 'agent',
      window: 'win-1',
    });

    const first = await upsert(base, { session_id: 's-architect', window: 'win-1' });
    assert.equal(first.agent?.id, a.id);
    assert.equal(first.previous, null);

    const cleared = await upsert(base, {
      session_id: 's-after-clear',
      window: 'win-1',
      source: 'clear',
    });
    assert.equal(cleared.agent?.id, a.id, 'the window keeps its agent after /clear');
    assert.equal(cleared.agent?.session_id, 's-after-clear');
    assert.equal(cleared.session.window, 'win-1');
    assert.equal(hub.stores.agents.bySession('s-architect'), undefined);
    assert.equal(hub.stores.sessions.get('s-after-clear')?.agent_id, a.id);

    const old = await registerAgent(base, 'designer');
    hub.stores.agents.setOffline(old.id);
    const resumed = await upsert(base, {
      session_id: 's-designer',
      window: 'win-1',
      source: 'resume',
    });
    assert.equal(
      resumed.agent?.id,
      a.id,
      'the live window wins over the offline agent of the resumed session',
    );
    assert.equal(resumed.previous?.id, old.id, 'but the hook learns who that session used to be');

    const open = await fetch(`${base}/v1/sessions/s-unknown/open?window=win-1`);
    const body = (await open.json()) as { agent: { name: string } | null };
    assert.equal(body.agent?.name, 'architect', 'pending/open relink by window too');
    assert.equal(hub.stores.agents.bySession('s-unknown')?.id, a.id);
  });
});

test('ending a session leaves an agent online while its edge still holds a stream', async () => {
  await withHub(async (hub, base) => {
    const a = await registerAgent(base, 'architect');
    const stream = await openStream(base, a);
    const end = await fetch(`${base}/v1/sessions/s-architect/end`, { method: 'POST' });
    assert.equal(end.status, 204);
    assert.equal(
      hub.stores.agents.byId(a.id)?.status,
      'online',
      'the window only switched sessions',
    );
    stream.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await fetch(`${base}/v1/sessions/s-architect/end`, { method: 'POST' });
    assert.equal(again.status, 204);
    assert.equal(hub.stores.agents.byId(a.id)?.status, 'offline');
  });
});

test('identifying a provisional agent announces an updated peer event', async () => {
  await withHub(
    async (_hub, base) => {
      const watcher = await registerAgent(base, 'watcher');
      const stream = await openStream(base, watcher);
      const res = await fetch(`${base}/v1/agents`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: 's-new',
          name: 'proj',
          description: 'not identified yet',
          capabilities: 'unknown',
          workspace: 'w',
          kind: 'agent',
          provisional: true,
          window: 'win-9',
        }),
      });
      assert.equal(res.status, 201);
      const [joined] = await stream.next(1);
      assert.deepEqual(joined?.data, {
        type: 'peer',
        event: 'joined',
        name: 'proj',
        description: 'not identified yet',
        kind: 'agent',
        provisional: true,
      });

      await fetch(`${base}/v1/agents`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: 's-new',
          name: 'designer',
          description: 'Designs components',
          capabilities: 'consult on UI',
          workspace: 'w',
          kind: 'agent',
          window: 'win-9',
        }),
      });
      const [updated] = await stream.next(1);
      assert.deepEqual(updated?.data, {
        type: 'peer',
        event: 'updated',
        name: 'designer',
        description: 'Designs components',
        kind: 'agent',
        provisional: false,
        previous_name: 'proj',
      });
      stream.close();
    },
    { keepaliveMs: 60_000 },
  );
});
