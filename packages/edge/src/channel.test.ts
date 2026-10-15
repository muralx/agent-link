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

test('renderChannelContent describes expectation, subject and final', () => {
  const base: HubEvent = {
    type: 'message',
    message,
    subject: 'Caching',
    participants: ['architect', 'designer'],
  };
  assert.equal(
    renderChannelContent(base),
    'architect → you (expects reply) in conversation cv_1 «Caching»:\n\nHello',
  );
  assert.match(
    renderChannelContent({ ...base, subject: null, message: { ...message, expectation: 'none' } })!,
    /^architect → you \(fyi\) in conversation cv_1:\n\nHello$/,
  );
  assert.match(
    renderChannelContent({
      ...base,
      message: { ...message, expectation: 'updates', final: true },
    })!,
    /\(wants updates\) in conversation cv_1 «Caching» \[final\]:/,
  );
});

test('peer events render joins and identifications, never leaves', () => {
  assert.equal(
    renderChannelContent({
      type: 'peer',
      event: 'joined',
      name: 'reviewer',
      description: 'Reviews PRs',
      kind: 'agent',
      provisional: false,
    }),
    'peer joined: reviewer — Reviews PRs',
  );
  assert.match(
    renderChannelContent({
      type: 'peer',
      event: 'joined',
      name: 'dana',
      description: 'Owner',
      kind: 'human',
      provisional: false,
    })!,
    /\(human\)/,
  );
  assert.equal(
    renderChannelContent({
      type: 'peer',
      event: 'joined',
      name: 'agent-link',
      description: 'Not yet',
      kind: 'agent',
      provisional: true,
    }),
    'peer joined: agent-link (provisional, not yet identified) — Not yet',
  );
  assert.equal(
    renderChannelContent({
      type: 'peer',
      event: 'updated',
      name: 'architect',
      description: 'Designs the hub',
      kind: 'agent',
      provisional: false,
      previous_name: 'agent-link',
    }),
    'peer identified: architect (was agent-link) — Designs the hub',
  );
  assert.equal(
    renderChannelContent({
      type: 'peer',
      event: 'left',
      name: 'reviewer',
      description: '',
      kind: 'agent',
      provisional: false,
    }),
    undefined,
  );
});

test('channelMeta uses only string values', () => {
  const meta = channelMeta({ type: 'message', message, subject: null, participants: [] });
  for (const v of Object.values(meta)) assert.equal(typeof v, 'string');
  assert.equal(meta['final'], 'false');
});

test('emitChannel emits and acks only when the channel is enabled', async () => {
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
});
