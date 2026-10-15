import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '@agent-link/hub';
import { HubApiError } from './hub-client.ts';
import { ensureHub } from './hub-launcher.ts';

test('ensureHub returns at once when the hub answers', async () => {
  const hub = createHub({ dbPath: ':memory:', port: 0 });
  const url = await hub.listen();
  let spawned = 0;
  await ensureHub({
    url,
    dataDir: mkdtempSync(join(tmpdir(), 'al-')),
    spawnHub: () => void spawned++,
  });
  assert.equal(spawned, 0);
  await hub.close();
});

test('ensureHub spawns the hub once under the lock and waits for health', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'al-'));
  const hub = createHub({ dbPath: ':memory:', port: 0 });
  let spawned = 0;
  const url = await hub.listen();
  await hub.close();
  const spawnHub = (): void => {
    spawned++;
    const again = createHub({ dbPath: ':memory:', port: Number(new URL(url).port) });
    void again.listen().then(() => setTimeout(() => void again.close(), 1500));
  };
  await Promise.all([
    ensureHub({ url, dataDir, spawnHub, pollMs: 20 }),
    ensureHub({ url, dataDir, spawnHub, pollMs: 20 }),
  ]);
  assert.equal(spawned, 1);
  await new Promise((r) => setTimeout(r, 1600));
});

test('ensureHub never spawns for a remote hub and reports hub_unavailable', async () => {
  let spawned = 0;
  const err = await ensureHub({
    url: 'http://10.255.255.1:1',
    dataDir: mkdtempSync(join(tmpdir(), 'al-')),
    spawnHub: () => void spawned++,
    timeoutMs: 300,
  }).catch((e: unknown) => e);
  assert.ok(err instanceof HubApiError);
  assert.equal(err.code, 'hub_unavailable');
  assert.equal(spawned, 0);
});

test('ensureHub gives up when the spawned hub never answers', async () => {
  const err = await ensureHub({
    url: 'http://127.0.0.1:1',
    dataDir: mkdtempSync(join(tmpdir(), 'al-')),
    spawnHub: () => undefined,
    timeoutMs: 200,
    pollMs: 20,
  }).catch((e: unknown) => e);
  assert.ok(err instanceof HubApiError && err.code === 'hub_unavailable');
});
