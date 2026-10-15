import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHubUrl, resolveWorkspace, DEFAULT_HUB_URL } from './config.ts';

test('resolveWorkspace walks up to .agent-link.json and honours the env override', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-link-ws-'));
  const deep = join(root, 'a', 'b');
  mkdirSync(deep, { recursive: true });
  assert.equal(resolveWorkspace(deep, {}), undefined);
  writeFileSync(join(root, '.agent-link.json'), JSON.stringify({ workspace: 'proj' }));
  assert.equal(resolveWorkspace(deep, {}), 'proj');
  assert.equal(resolveWorkspace(deep, { AGENT_LINK_WORKSPACE: 'forced' }), 'forced');
  writeFileSync(join(deep, '.agent-link.json'), 'not json');
  assert.equal(
    resolveWorkspace(deep, {}),
    'proj',
    'a broken file is skipped and the search continues',
  );
});

test('resolveHubUrl prefers env, then config.json, then hub.json, then the default', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-link-home-'));
  const configDir = join(home, 'config', 'agent-link');
  const dataDir = join(home, 'data', 'agent-link');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const env = { XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data') };
  assert.equal(resolveHubUrl(env), DEFAULT_HUB_URL);
  writeFileSync(join(dataDir, 'hub.json'), JSON.stringify({ url: 'http://127.0.0.1:9001' }));
  assert.equal(resolveHubUrl(env), 'http://127.0.0.1:9001');
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ hub: 'http://10.0.0.5:8790' }));
  assert.equal(resolveHubUrl(env), 'http://10.0.0.5:8790');
  assert.equal(
    resolveHubUrl({ ...env, AGENT_LINK_HUB: 'http://127.0.0.1:7777/' }),
    'http://127.0.0.1:7777',
  );
});
