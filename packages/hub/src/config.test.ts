import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';

test('defaults follow XDG and port 8790', () => {
  const c = loadConfig({});
  assert.equal(c.dataDir, join(homedir(), '.local', 'share', 'agent-link'));
  assert.equal(c.dbPath, join(c.dataDir, 'agent-link.db'));
  assert.equal(c.hubJsonPath, join(c.dataDir, 'hub.json'));
  assert.equal(c.logPath, join(c.dataDir, 'hub.log'));
  assert.equal(c.port, 8790);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.guard, true);
});

test('environment overrides win', () => {
  const xdg = loadConfig({ XDG_DATA_HOME: '/xdg' });
  assert.equal(xdg.dataDir, '/xdg/agent-link');
  const c = loadConfig({
    AGENT_LINK_DATA_DIR: '/d',
    AGENT_LINK_PORT: '0',
    AGENT_LINK_HOST: '0.0.0.0',
    XDG_DATA_HOME: '/xdg',
  });
  assert.equal(c.dataDir, '/d');
  assert.equal(c.port, 0);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(loadConfig({ AGENT_LINK_PORT: 'junk' }).port, 8790);
  assert.equal(loadConfig({ AGENT_LINK_GUARD: 'off' }).guard, false);
});
