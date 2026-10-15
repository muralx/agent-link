import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiErrorSchema,
  ErrorCodeSchema,
  ExpectationSchema,
  HubEventSchema,
  MessageBodySchema,
  RegisterInputSchema,
  RegisterRequestSchema,
  SendInputSchema,
} from './schemas.ts';

test('expectation accepts the three agreed values only', () => {
  for (const v of ['reply', 'none', 'updates']) assert.equal(ExpectationSchema.parse(v), v);
  assert.equal(ExpectationSchema.safeParse('ack').success, false);
});

test('send input needs recipients unless it continues a conversation', () => {
  assert.equal(SendInputSchema.safeParse({ body: 'hi' }).success, false);
  const fresh = SendInputSchema.parse({ to: ['architect'], body: 'hi' });
  assert.equal(fresh.expectation, 'none');
  assert.equal(fresh.final, false);
  const cont = SendInputSchema.parse({ conversation_id: 'cv_x', body: 'hi' });
  assert.equal(cont.to, undefined);
  assert.equal(SendInputSchema.parse({ to: '*', body: 'all' }).to, '*');
  assert.equal(SendInputSchema.safeParse({ to: [], body: 'hi' }).success, false);
});

test('message body must be non-empty and at most 64 KiB', () => {
  assert.equal(MessageBodySchema.safeParse('').success, false);
  assert.equal(MessageBodySchema.safeParse('x'.repeat(65536)).success, true);
  assert.equal(MessageBodySchema.safeParse('x'.repeat(65537)).success, false);
});

test('register input requires name, description and capabilities; session is optional', () => {
  const ok = RegisterInputSchema.parse({
    session_id: 's1',
    name: 'architect',
    description: 'Designs the system',
    capabilities: 'consult, resolve',
  });
  assert.equal(ok.kind, 'agent');
  assert.equal(ok.provisional, false);
  assert.equal(
    RegisterInputSchema.safeParse({ name: 'x', description: 'd', capabilities: 'c' }).success,
    true,
    'the edge fills in the session id',
  );
  assert.equal(
    RegisterRequestSchema.safeParse({ name: 'x', description: 'd', capabilities: 'c' }).success,
    false,
    'the hub always needs one',
  );
  assert.equal(
    RegisterInputSchema.safeParse({
      session_id: 's',
      name: 'bad name!',
      description: 'd',
      capabilities: 'c',
    }).success,
    false,
  );
});

test('error codes cover the spec table and api errors may carry extras', () => {
  for (const code of [
    'hub_unavailable',
    'not_registered',
    'session_required',
    'workspace_required',
    'peer_not_found',
    'not_participant',
    'invalid_message',
    'unauthorized',
    'not_found',
  ]) {
    assert.equal(ErrorCodeSchema.parse(code), code);
  }
  const err = ApiErrorSchema.parse({ error: 'peer_not_found', message: 'no', online: ['a'] });
  assert.deepEqual(err['online'], ['a']);
});

test('hub events discriminate on type', () => {
  const peer = HubEventSchema.parse({
    type: 'peer',
    event: 'joined',
    name: 'reviewer',
    description: 'Reviews PRs',
    kind: 'agent',
    provisional: false,
  });
  assert.equal(peer.type, 'peer');
  assert.equal(HubEventSchema.safeParse({ type: 'bogus' }).success, false);
});
