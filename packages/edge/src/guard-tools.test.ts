import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openEdge, startTestHub, type TestEdge } from './testkit.ts';

type Json = Record<string, unknown>;

/** identify registers an edge with extra register fields (kind, watcher). */
function identify(edge: TestEdge, name: string, extra: Json = {}): Promise<Json> {
  return edge.call('register', {
    session_id: edge.sessionId,
    name,
    description: `${name} does things`,
    capabilities: 'consult',
    ...extra,
  });
}

test('guard and audit tools: quarantine by rule, status, human release, watcher request and feed', async () => {
  const { hub, url } = await startTestHub();
  const edges = await Promise.all([1, 2, 3, 4].map(() => openEdge(url, 'w')));
  const [human, watcher, a, b] = edges as [TestEdge, TestEdge, TestEdge, TestEdge];
  try {
    assert.equal((await identify(human, 'alice', { kind: 'human' }))['kind'], 'human');
    assert.equal((await identify(watcher, 'watcher', { watcher: true }))['watcher'], true);
    await identify(a, 'a');
    await identify(b, 'b');

    const start = await watcher.call('audit', { action: 'feed' });
    assert.deepEqual(start['messages'], []);
    assert.equal((await a.call('audit', { action: 'conversations' }))['error'], 'unauthorized');
    assert.equal((await a.call('audit', { action: 'conversation' }))['error'], 'invalid_message');

    for (let i = 0; i < 5; i++) {
      assert.ok((await a.call('send', { to: ['b'], body: 'ping' }))['message_id']);
    }
    const refused = await a.call('send', { to: ['b'], body: 'ping' });
    assert.equal(refused['error'], 'quarantined');
    assert.match(String(refused['hint']), /tell the person at your keyboard/);
    assert.equal(
      (await a.call('reply', { conversation_id: 'cv_x', body: 'y' }))['error'],
      'quarantined',
    );

    const peers = (await b.call('peers'))['peers'] as Json[];
    assert.equal(peers.find((p) => p['name'] === 'a')?.['quarantined'], true);

    const status = await a.call('guard', { action: 'status' });
    assert.equal((status['quarantined'] as Json[])[0]?.['name'], 'a');
    assert.equal((status['incidents'] as Json[])[0]?.['rule'], 'repeat');

    const feed = await watcher.call('audit', {
      action: 'feed',
      since: (await firstMessageId(watcher)) ?? '',
      wait_s: 1,
    });
    assert.equal((feed['messages'] as Json[]).length >= 4, true);
    assert.equal(typeof feed['cursor'], 'string');
    const list = (await watcher.call('audit', { action: 'conversations' }))['conversations'];
    assert.equal((list as Json[]).length >= 5, true);
    const one = await human.call('audit', {
      action: 'conversation',
      conversation_id: (list as Json[]).find((c) =>
        (c['participants'] as string[]).includes('b'),
      )?.['id'],
    });
    assert.equal((one['messages'] as Json[])[0]?.['body'], 'ping');
    assert.ok((await human.call('audit', { action: 'incidents' }))['incidents']);

    assert.equal(
      (await watcher.call('guard', { action: 'release', name: 'a' }))['error'],
      'unauthorized',
    );
    assert.equal(
      (await watcher.call('guard', { action: 'request', name: 'b' }))['error'],
      'invalid_message',
    );
    const asked = await watcher.call('guard', { action: 'request', name: 'b', reason: 'odd' });
    assert.equal(asked['action'], 'requested');

    const notices = (await human.call('inbox'))['messages'] as Json[];
    assert.equal(
      notices.some(
        (m) => m['from'] === 'guard' && /quarantined by the guard/.test(String(m['body'])),
      ),
      true,
    );
    const released = await human.call('guard', { action: 'release', name: 'a', reason: 'ok' });
    assert.equal(released['action'], 'released');
    assert.ok((await a.call('send', { to: ['b'], body: 'back' }))['message_id']);
    const manual = await human.call('guard', { action: 'quarantine', name: 'b', reason: 'test' });
    assert.equal(manual['action'], 'quarantined');
    assert.equal((await b.call('send', { to: ['a'], body: 'x' }))['error'], 'quarantined');
  } finally {
    for (const e of edges) await e.close();
    await hub.close();
  }
});

/**
 * firstMessageId returns the id of the oldest message the observer can see in
 * the workspace audit view.
 */
async function firstMessageId(observer: TestEdge): Promise<string | undefined> {
  const list = (await observer.call('audit', { action: 'conversations' }))['conversations'];
  const oldest = (list as Json[]).at(-1);
  const thread = await observer.call('audit', {
    action: 'conversation',
    conversation_id: oldest?.['id'],
  });
  return (thread['messages'] as Json[])[0]?.['id'] as string | undefined;
}
