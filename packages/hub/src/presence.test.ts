import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceTracker } from './presence.ts';

test('an agent expires 30 s after its last stream closes unless it reconnects', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const expired: string[] = [];
    const p = new PresenceTracker((id) => expired.push(id), 30_000);
    assert.equal(p.isConnected('a'), false);
    p.connected('a');
    p.connected('a');
    p.disconnected('a');
    mock.timers.tick(60_000);
    assert.deepEqual(expired, [], 'one stream is still open');
    assert.equal(p.isConnected('a'), true);
    p.disconnected('a');
    assert.equal(
      p.isConnected('a'),
      false,
      'within the grace the agent is online but not connected',
    );
    mock.timers.tick(29_000);
    assert.deepEqual(expired, []);
    p.connected('a');
    mock.timers.tick(60_000);
    assert.deepEqual(expired, [], 'reconnect within the grace cancels expiry');
    p.disconnected('a');
    mock.timers.tick(30_000);
    assert.deepEqual(expired, ['a']);
    p.disconnected('b');
    p.forget('b');
    mock.timers.tick(60_000);
    assert.deepEqual(expired, ['a'], 'forget cancels a pending expiry');
    p.disconnected('c');
    p.close();
    mock.timers.tick(60_000);
    assert.deepEqual(expired, ['a']);
  } finally {
    mock.timers.reset();
  }
});
