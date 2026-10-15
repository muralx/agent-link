import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './events.ts';
import type { HubEvent } from '@agent-link/protocol';

const peer: HubEvent = {
  type: 'peer',
  event: 'joined',
  name: 'x',
  description: 'd',
  kind: 'agent',
  provisional: false,
};

test('subscribers receive events for their agent only until they unsubscribe', () => {
  const bus = new EventBus();
  const got: HubEvent[] = [];
  const off = bus.subscribe('a', (e) => got.push(e));
  bus.publish('a', peer);
  bus.publish('b', peer);
  assert.equal(got.length, 1);
  off();
  bus.publish('a', peer);
  assert.equal(got.length, 1);
});

test('waitFor resolves on the first event or undefined on timeout', async () => {
  const bus = new EventBus();
  const pending = bus.waitFor('a', 1000);
  bus.publish('a', peer);
  assert.deepEqual(await pending, peer);
  assert.equal(await bus.waitFor('a', 20), undefined);
  assert.equal(bus.listenerCount('a'), 0);
});
