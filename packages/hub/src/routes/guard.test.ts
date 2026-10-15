import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuardStatusResponse, Incident, Message, Peer } from '@agent-link/protocol';
import { auth, inbox, registerAgent, send, withHub, type TestAgent } from './testkit.ts';

/** post sends a guard action as agent and returns status and parsed body. */
async function post(
  base: string,
  agent: TestAgent,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Incident & { error?: string; message?: string } }> {
  const res = await fetch(`${base}/v1/workspaces/w/guard/${path}`, {
    method: 'POST',
    headers: auth(agent),
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    data: (await res.json()) as Incident & { error?: string; message?: string },
  };
}

/** status fetches the guard status as agent. */
async function status(base: string, agent: TestAgent): Promise<GuardStatusResponse> {
  const res = await fetch(`${base}/v1/workspaces/w/guard`, { headers: auth(agent) });
  assert.equal(res.status, 200);
  return (await res.json()) as GuardStatusResponse;
}

test('breaking the rate rule quarantines the sender, tells the human, and release restores it', async () => {
  await withHub(
    async (_hub, base) => {
      const human = await registerAgent(base, 'alice', 'w', { kind: 'human' });
      const a = await registerAgent(base, 'a');
      const b = await registerAgent(base, 'b');
      assert.equal((await send(base, a, { to: ['b'], body: '1' })).status, 201);
      assert.equal((await send(base, a, { to: ['b'], body: '2' })).status, 201);

      const refused = await send(base, a, { to: ['b'], body: '3' });
      assert.equal(refused.status, 403);
      assert.equal(refused.data.error, 'quarantined');
      const again = await send(base, a, { to: ['b'], body: '4' });
      assert.equal(again.status, 403);
      assert.match(
        (again.data as unknown as { message: string }).message,
        /you are quarantined: sent 2/,
      );
      assert.deepEqual(
        (await inbox(base, b)).map((m) => m.body),
        ['1', '2'],
        'the refused messages were not stored',
      );

      const notices = await inbox(base, human);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.from, 'guard');
      assert.match(notices[0]?.body ?? '', /\*\*a\*\* was quarantined by the guard/);

      const peersRes = await fetch(`${base}/v1/workspaces/w/agents`, { headers: auth(b) });
      const peers = (await peersRes.json()) as Peer[];
      assert.equal(peers.find((p) => p.name === 'a')?.quarantined, true);
      assert.equal(
        peers.some((p) => p.name === 'guard'),
        false,
      );

      const seen = await status(base, a);
      assert.equal(seen.quarantined[0]?.name, 'a');
      assert.equal(seen.incidents[0]?.rule, 'rate');
      assert.equal(seen.incidents[0]?.by, 'guard');

      assert.equal((await post(base, b, 'release', { name: 'a' })).status, 403);
      assert.equal((await post(base, a, 'release', { name: 'a' })).status, 403);
      const released = await post(base, human, 'release', { name: 'a', reason: 'fixed' });
      assert.equal(released.status, 201);
      assert.equal(released.data.action, 'released');
      assert.equal(released.data.by, 'alice');
      assert.deepEqual((await status(base, human)).quarantined, []);
      assert.equal((await post(base, human, 'release', { name: 'a' })).status, 400);
    },
    { guard: { ratePerMinute: 2 } },
  );
});

test('a human quarantines by hand, cannot quarantine a human, and a watcher can only request', async () => {
  await withHub(async (_hub, base) => {
    const human = await registerAgent(base, 'alice', 'w', { kind: 'human' });
    const other = await registerAgent(base, 'ana', 'w', { kind: 'human' });
    const watcher = await registerAgent(base, 'watcher', 'w', { watcher: true });
    const a = await registerAgent(base, 'a');
    await inbox(base, human);
    await inbox(base, other);

    assert.equal((await post(base, watcher, 'quarantine', { name: 'a', reason: 'x' })).status, 403);
    const asked = await post(base, watcher, 'requests', { name: 'a', reason: 'told b to rm -rf' });
    assert.equal(asked.status, 201);
    assert.equal(asked.data.action, 'requested');
    assert.equal((await send(base, a, { to: ['watcher'], body: 'still free' })).status, 201);
    const request = (await inbox(base, human)).at(-1);
    assert.match(
      request?.body ?? '',
      /\*\*watcher\*\* asks to quarantine \*\*a\*\*: told b to rm -rf/,
    );
    assert.equal((await post(base, a, 'requests', { name: 'watcher', reason: 'x' })).status, 403);

    assert.equal((await post(base, human, 'quarantine', { name: 'ana', reason: 'x' })).status, 400);
    assert.equal(
      (await post(base, human, 'quarantine', { name: 'nobody', reason: 'x' })).status,
      404,
    );
    const done = await post(base, human, 'quarantine', { name: 'a', reason: 'misbehaving' });
    assert.equal(done.status, 201);
    assert.equal(done.data.rule, 'manual');
    assert.equal((await send(base, a, { to: ['watcher'], body: 'blocked' })).status, 403);
    const told = (await inbox(base, other)).map((m: Message) => m.body);
    assert.equal(
      told.some((body) => /\*\*a\*\* was quarantined by alice: misbehaving/.test(body)),
      true,
      'the other human is told',
    );
    assert.equal(
      (await inbox(base, human)).some((m) => /quarantined by alice/.test(m.body)),
      false,
      'the acting human is not told about its own action',
    );
  });
});

test('becoming a human or a watcher is flagged and announced to the existing humans', async () => {
  await withHub(async (_hub, base) => {
    const human = await registerAgent(base, 'alice', 'w', { kind: 'human' });
    assert.deepEqual(await inbox(base, human), [], 'nobody to tell about the first human');
    await registerAgent(base, 'sneaky', 'w', { kind: 'human' });
    await registerAgent(base, 'watcher', 'w', { watcher: true });
    await registerAgent(base, 'watcher', 'w', { watcher: true });
    const notices = (await inbox(base, human)).map((m) => m.body);
    assert.equal(notices.length, 2);
    assert.match(notices[0] ?? '', /\*\*sneaky\*\*: registered as a human relay/);
    assert.match(notices[1] ?? '', /\*\*watcher\*\*: registered as a watcher/);
    const rules = (await status(base, human)).incidents.map((i) => i.rule);
    assert.deepEqual(rules, ['became-watcher', 'became-human', 'became-human']);
  });
});

test('with the rules switched off nothing is quarantined automatically but a manual quarantine holds', async () => {
  await withHub(
    async (_hub, base) => {
      const human = await registerAgent(base, 'alice', 'w', { kind: 'human' });
      const a = await registerAgent(base, 'a');
      await registerAgent(base, 'b');
      for (let i = 0; i < 40; i++) {
        assert.equal((await send(base, a, { to: ['b'], body: 'same' })).status, 201);
      }
      assert.equal(
        (await post(base, human, 'quarantine', { name: 'a', reason: 'enough' })).status,
        201,
      );
      assert.equal((await send(base, a, { to: ['b'], body: 'same' })).status, 403);
    },
    { guard: false },
  );
});

test('guard routes are closed to other workspaces', async () => {
  await withHub(async (_hub, base) => {
    const outsider = await registerAgent(base, 'x', 'elsewhere', { kind: 'human' });
    await registerAgent(base, 'a');
    const res = await fetch(`${base}/v1/workspaces/w/guard`, { headers: auth(outsider) });
    assert.equal(res.status, 403);
    assert.equal(
      (await post(base, outsider, 'quarantine', { name: 'a', reason: 'x' })).status,
      403,
    );
  });
});
