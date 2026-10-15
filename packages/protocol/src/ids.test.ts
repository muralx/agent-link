import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from './ids.ts';

test('newId prefixes and uses 20 lowercase base32 characters', () => {
  assert.match(newId('ag'), /^ag_[0-9a-z]{20}$/);
  assert.match(newId('msg'), /^msg_[0-9a-z]{20}$/);
});

test('newId does not repeat across a thousand draws', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(newId('cv'));
  assert.equal(seen.size, 1000);
});
