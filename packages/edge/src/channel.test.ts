import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HubEvent, Message } from '@agent-link/protocol';
import { channelMeta, emitChannel, renderChannelContent } from './channel.ts';
import type { HubClient } from './hub-client.ts';
import type { Identity } from './session.ts';

const message: Message = {
  id: 'msg_1',
  conversation_id: 'cv_1',
  from: 'architect',
  to: ['designer'],
  body: 'Hello',
  expectation: 'reply',
  final: false,
  in_reply_to: null,
  created_at: '2026-10-10T00:00:00.000Z',
};

test('a message shows subject, audience and final, never the fields the tag already carries', () => {
  const base: HubEvent = {
    type: 'message',
    message,
    subject: 'Caching',
    participants: ['architect', 'designer'],
    kind: 'direct',
    starter: 'architect',
    wake: true,
  };
  assert.equal(renderChannelContent(base, 'designer'), '«Caching»\n\nHello');
  assert.equal(renderChannelContent({ ...base, subject: null }, 'designer'), 'Hello');
  assert.equal(
    renderChannelContent({ ...base, message: { ...message, final: true } }, 'designer'),
    '«Caching» — [final]\n\nHello',
  );
  const announcement: HubEvent = {
    ...base,
    kind: 'announcement',
    participants: ['architect', 'designer', 'reviewer', 'tester'],
  };
  assert.equal(
    renderChannelContent(announcement, 'designer'),
    '«Caching» — announcement from architect to 3 peers; your reply goes to architect only\n\nHello',
  );
  assert.match(renderChannelContent(announcement, 'architect')!, /reply to your announcement/);
  assert.match(
    renderChannelContent({ ...announcement, kind: 'group' }, 'designer')!,
    /group with architect, reviewer, tester; replies reach everyone/,
  );
});

test('peer events are never pushed', () => {
  for (const event of ['joined', 'updated', 'left'] as const) {
    assert.equal(
      renderChannelContent({
        type: 'peer',
        event,
        name: 'reviewer',
        description: 'Reviews PRs',
        kind: 'agent',
        provisional: false,
      }),
      undefined,
    );
  }
});

test('channelMeta uses only string values', () => {
  const meta = channelMeta({
    type: 'message',
    message,
    subject: null,
    participants: [],
    kind: 'announcement',
    wake: true,
  });
  for (const v of Object.values(meta)) assert.equal(typeof v, 'string');
  assert.equal(meta['final'], 'false');
  assert.equal(meta['kind'], 'announcement');
});

test('emitChannel emits and acks only when the channel is enabled and the window should wake', async () => {
  const sent: unknown[] = [];
  const acked: unknown[] = [];
  const sink = {
    notification: (n: unknown) => {
      sent.push(n);
      return Promise.resolve();
    },
  };
  const client = {
    ackDelivery: (...args: unknown[]) => {
      acked.push(args);
      return Promise.resolve();
    },
  } as unknown as HubClient;
  const identity: Identity = {
    agentId: 'ag_1',
    token: 't',
    name: 'designer',
    workspace: 'w',
    kind: 'agent',
    provisional: false,
    sessionId: 's',
  };
  const event: HubEvent = {
    type: 'message',
    message,
    subject: null,
    participants: ['architect', 'designer'],
    kind: 'direct',
    wake: true,
  };
  assert.equal(
    await emitChannel(sink, client, identity, event, false),
    false,
    'no channel: nothing emitted',
  );
  assert.equal(sent.length, 0);
  assert.equal(acked.length, 0, 'the delivery stays queued for the hooks');
  assert.equal(
    await emitChannel(sink, client, identity, event, undefined),
    true,
    'unknown counts as enabled',
  );
  assert.equal(sent.length, 1);
  assert.deepEqual(acked[0], ['msg_1', 'ag_1', 't', 'notified', 'channel']);
  assert.equal(
    await emitChannel(sink, client, identity, { ...event, wake: false }),
    false,
    'information between agents waits for the hooks',
  );
  assert.equal(
    await emitChannel(sink, client, identity, event, true, () => true),
    false,
    'an active await returns it instead',
  );
  assert.equal(sent.length, 1);
  assert.equal(acked.length, 1, 'skipped deliveries stay queued');
});
