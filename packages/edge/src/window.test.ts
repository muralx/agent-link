import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelEnabled, currentWindowId } from './window.ts';

function fakeProc(
  processes: { pid: number; comm: string; ppid: number; starttime: number; args?: string[] }[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-link-proc-'));
  mkdirSync(join(root, 'sys/kernel/random'), { recursive: true });
  writeFileSync(join(root, 'sys/kernel/random/boot_id'), '4095152c-cf54-440c-aab4-5f6a95dc2d91\n');
  for (const p of processes) {
    mkdirSync(join(root, String(p.pid)));
    const fields = Array.from({ length: 50 }, (_, i) => String(i));
    fields[19] = String(p.starttime); // field 22 overall
    writeFileSync(
      join(root, String(p.pid), 'stat'),
      `${p.pid} (${p.comm}) S ${p.ppid} ${fields.slice(2).join(' ')}\n`,
    );
    if (p.args) writeFileSync(join(root, String(p.pid), 'cmdline'), `${p.args.join('\0')}\0`);
  }
  return root;
}

test('currentWindowId walks up to the claude process and tags it with boot id, pid and start time', () => {
  const procRoot = fakeProc([
    { pid: 1, comm: 'systemd', ppid: 0, starttime: 1 },
    { pid: 100, comm: 'claude', ppid: 1, starttime: 35425165 },
    { pid: 200, comm: 'bash', ppid: 100, starttime: 99 },
    { pid: 300, comm: 'node', ppid: 200, starttime: 100 },
    { pid: 400, comm: 'node (edge)', ppid: 100, starttime: 101 },
  ]);
  const hook = currentWindowId({ procRoot, pid: 300, platform: 'linux', env: {} });
  const edge = currentWindowId({ procRoot, pid: 400, platform: 'linux', env: {} });
  assert.equal(hook, '4095152c-100-35425165');
  assert.equal(edge, hook, 'hook and edge of one window agree');
});

test('currentWindowId falls back to CLAUDE_PID and gives up cleanly', () => {
  const procRoot = fakeProc([
    { pid: 1, comm: 'systemd', ppid: 0, starttime: 1 },
    { pid: 100, comm: 'claude', ppid: 1, starttime: 7 },
    { pid: 500, comm: 'node', ppid: 1, starttime: 8 },
  ]);
  assert.equal(
    currentWindowId({ procRoot, pid: 500, platform: 'linux', env: { CLAUDE_PID: '100' } }),
    '4095152c-100-7',
  );
  assert.equal(currentWindowId({ procRoot, pid: 500, platform: 'linux', env: {} }), undefined);
  assert.equal(currentWindowId({ procRoot, pid: 999, platform: 'linux', env: {} }), undefined);
  assert.equal(currentWindowId({ procRoot, pid: 300, platform: 'darwin', env: {} }), undefined);
  assert.equal(
    currentWindowId({ procRoot, pid: 300, platform: 'darwin', env: { AGENT_LINK_WINDOW: 'w-1' } }),
    'w-1',
    'the override wins everywhere',
  );
});

test('currentWindowId on this machine returns something or nothing, never throws', () => {
  const id = currentWindowId();
  assert.ok(id === undefined || /^[0-9a-f]{8}-\d+-\d+$/.test(id), id);
});

test('channelEnabled reads the channels flag off the claude process command line', () => {
  const withFlag = fakeProc([
    { pid: 1, comm: 'systemd', ppid: 0, starttime: 1 },
    {
      pid: 100,
      comm: 'claude',
      ppid: 1,
      starttime: 5,
      args: ['claude', '--dangerously-load-development-channels', 'plugin:agent-link@agent-link'],
    },
    { pid: 300, comm: 'node', ppid: 100, starttime: 6 },
  ]);
  assert.equal(channelEnabled({ procRoot: withFlag, pid: 300, platform: 'linux', env: {} }), true);
  const equalsForm = fakeProc([
    { pid: 1, comm: 'systemd', ppid: 0, starttime: 1 },
    {
      pid: 100,
      comm: 'claude',
      ppid: 1,
      starttime: 5,
      args: ['claude', '--dangerously-load-development-channels=server:other,server:agent-link'],
    },
    { pid: 300, comm: 'node', ppid: 100, starttime: 6 },
  ]);
  assert.equal(
    channelEnabled({ procRoot: equalsForm, pid: 300, platform: 'linux', env: {} }),
    true,
  );
  const without = fakeProc([
    { pid: 1, comm: 'systemd', ppid: 0, starttime: 1 },
    { pid: 100, comm: 'claude', ppid: 1, starttime: 5, args: ['claude', '--resume', 'x'] },
    { pid: 300, comm: 'node', ppid: 100, starttime: 6 },
  ]);
  assert.equal(channelEnabled({ procRoot: without, pid: 300, platform: 'linux', env: {} }), false);
  const otherPlugin = fakeProc([
    { pid: 1, comm: 'systemd', ppid: 0, starttime: 1 },
    {
      pid: 100,
      comm: 'claude',
      ppid: 1,
      starttime: 5,
      args: ['claude', '--dangerously-load-development-channels', 'plugin:agent-linker@m'],
    },
    { pid: 300, comm: 'node', ppid: 100, starttime: 6 },
  ]);
  assert.equal(
    channelEnabled({ procRoot: otherPlugin, pid: 300, platform: 'linux', env: {} }),
    false,
  );
});

test('channelEnabled is unknown without a claude ancestor and obeys AGENT_LINK_CHANNEL', () => {
  const procRoot = fakeProc([
    { pid: 1, comm: 'systemd', ppid: 0, starttime: 1 },
    { pid: 500, comm: 'node', ppid: 1, starttime: 8 },
    { pid: 100, comm: 'claude', ppid: 1, starttime: 5 }, // no cmdline file
  ]);
  assert.equal(channelEnabled({ procRoot, pid: 500, platform: 'linux', env: {} }), undefined);
  assert.equal(
    channelEnabled({ procRoot, pid: 500, platform: 'linux', env: { CLAUDE_PID: '100' } }),
    undefined,
    'unreadable cmdline is unknown',
  );
  assert.equal(channelEnabled({ procRoot, pid: 500, platform: 'darwin', env: {} }), undefined);
  assert.equal(
    channelEnabled({ procRoot, pid: 500, platform: 'darwin', env: { AGENT_LINK_CHANNEL: 'on' } }),
    true,
  );
  assert.equal(
    channelEnabled({ procRoot, pid: 500, platform: 'linux', env: { AGENT_LINK_CHANNEL: 'off' } }),
    false,
  );
  assert.doesNotThrow(() => channelEnabled());
});
