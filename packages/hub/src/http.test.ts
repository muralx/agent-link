import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Router, bearerToken } from './http.ts';
import { HubError } from './store/errors.ts';

async function withRouter(router: Router, fn: (base: string) => Promise<void>) {
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('router matches params, parses json bodies and renders errors', async () => {
  const router = new Router();
  router.add('GET', '/v1/agents/:id/inbox', ({ params, query }) => ({
    body: { id: params['id'], limit: query.get('limit') },
  }));
  router.add('POST', '/v1/echo', async ({ readJson }) => ({ status: 201, body: await readJson() }));
  router.add('GET', '/v1/boom', () => {
    throw new HubError('peer_not_found', 'no such peer', { extra: { online: ['a'] } });
  });
  router.add('GET', '/v1/crash', () => {
    throw new Error('unexpected');
  });
  await withRouter(router, async (base) => {
    const r1 = await fetch(`${base}/v1/agents/ag_1/inbox?limit=5`);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { id: 'ag_1', limit: '5' });

    const r2 = await fetch(`${base}/v1/echo`, { method: 'POST', body: JSON.stringify({ x: 1 }) });
    assert.equal(r2.status, 201);
    assert.deepEqual(await r2.json(), { x: 1 });

    const r3 = await fetch(`${base}/v1/nope`);
    assert.equal(r3.status, 404);
    assert.equal(((await r3.json()) as { error: string }).error, 'not_found');

    const r4 = await fetch(`${base}/v1/boom`);
    assert.equal(r4.status, 404);
    assert.deepEqual(await r4.json(), {
      error: 'peer_not_found',
      message: 'no such peer',
      online: ['a'],
    });

    const r5 = await fetch(`${base}/v1/crash`);
    assert.equal(r5.status, 500);

    const r6 = await fetch(`${base}/v1/echo`, { method: 'POST', body: 'not json' });
    assert.equal(r6.status, 400);

    const big = 'x'.repeat(1_100_000);
    const r7 = await fetch(`${base}/v1/echo`, { method: 'POST', body: JSON.stringify({ big }) });
    assert.equal(r7.status, 413);
  });
});

test('bearerToken extracts the token or returns undefined', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc' } }), undefined);
  assert.equal(bearerToken({ headers: {} }), undefined);
});
