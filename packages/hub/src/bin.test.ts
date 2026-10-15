import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url));

test('agent-linkd starts, writes hub.json, answers health and cleans up on SIGTERM', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-linkd-'));
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', BIN], {
    env: { ...process.env, AGENT_LINK_DATA_DIR: dataDir, AGENT_LINK_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n')[0];
      if (line && out.includes('\n')) resolve(line.trim());
    });
    child.on('exit', (code) => reject(new Error(`exited early with ${code}`)));
    setTimeout(() => reject(new Error(`no url printed; stdout=${out}`)), 10_000);
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const health = await fetch(`${url}/v1/health`);
  assert.equal(health.status, 200);
  const hubJson = JSON.parse(readFileSync(join(dataDir, 'hub.json'), 'utf8')) as {
    url: string;
    pid: number;
  };
  assert.equal(hubJson.url, url);
  assert.equal(hubJson.pid, child.pid);
  assert.ok(existsSync(join(dataDir, 'agent-link.db')));

  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(existsSync(join(dataDir, 'hub.json')), false);
});
