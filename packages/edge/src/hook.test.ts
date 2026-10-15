import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubClient } from './hub-client.ts';
import { runHook } from './hook.ts';
import { openEdge, startTestHub, workspaceDir } from './testkit.ts';

interface HookOutput {
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  decision?: string;
  reason?: string;
}

function parse(stdout: string): HookOutput {
  return stdout === '' ? {} : (JSON.parse(stdout) as HookOutput);
}

test('session-start explains agent-link, follows the window and describes the agent state', async () => {
  const { hub, url } = await startTestHub();
  const client = new HubClient(url);
  try {
    const cwd = workspaceDir('proj');
    const res = await runHook(
      'session-start',
      { session_id: 'sess-1', cwd, source: 'startup' },
      { client, env: {}, window: 'win-1' },
    );
    assert.equal(res.exitCode, 0);
    const out = parse(res.stdout);
    assert.equal(out.hookSpecificOutput?.hookEventName, 'SessionStart');
    const text = out.hookSpecificOutput?.additionalContext ?? '';
    assert.match(text, /session id is "sess-1"/);
    assert.match(text, /workspace "proj"/);
    assert.match(text, /registers this window provisionally/);
    assert.equal(hub.stores.sessions.get('sess-1')?.workspace_hint, 'proj');
    assert.equal(hub.stores.sessions.get('sess-1')?.window, 'win-1');

    hub.stores.agents.register({
      session_id: 'sess-1',
      name: 'proj',
      description: 'placeholder',
      capabilities: 'unknown',
      workspace: 'proj',
      kind: 'agent',
      provisional: true,
      window: 'win-1',
    });
    const provisional = await runHook(
      'session-start',
      { session_id: 'sess-1', cwd, source: 'compact' },
      { client, env: {}, window: 'win-1' },
    );
    assert.match(
      parse(provisional.stdout).hookSpecificOutput?.additionalContext ?? '',
      /registered provisionally as "proj".*Identify yourself/,
    );

    hub.stores.agents.register({
      session_id: 'sess-1',
      name: 'architect',
      description: 'Designs the hub.',
      capabilities: 'consult',
      workspace: 'proj',
      kind: 'agent',
      window: 'win-1',
    });
    const cleared = await runHook(
      'session-start',
      { session_id: 'sess-2', cwd, source: 'clear' },
      { client, env: {}, window: 'win-1' },
    );
    const clearedText = parse(cleared.stdout).hookSpecificOutput?.additionalContext ?? '';
    assert.match(clearedText, /registered as "architect" \(agent\): Designs the hub\./);
    assert.equal(
      hub.stores.agents.bySession('sess-2')?.name,
      'architect',
      'the window keeps its agent across /clear',
    );

    const old = hub.stores.agents.register({
      session_id: 'sess-old',
      name: 'designer',
      description: 'Designed components.',
      capabilities: 'consult',
      workspace: 'proj',
      kind: 'agent',
    });
    hub.stores.agents.setOffline(old.agent.id);
    const resumed = await runHook(
      'session-start',
      { session_id: 'sess-old', cwd, source: 'resume' },
      { client, env: {}, window: 'win-1' },
    );
    const resumedText = parse(resumed.stdout).hookSpecificOutput?.additionalContext ?? '';
    assert.match(resumedText, /registered as "architect"/);
    assert.match(resumedText, /previously ran as "designer"/);

    const bare = await runHook(
      'session-start',
      { session_id: 'sess-9', cwd: mkdtempSync(join(tmpdir(), 'bare-')) },
      { client, env: {} },
    );
    assert.equal(bare.stdout, '', 'repositories without .agent-link.json are left alone');
  } finally {
    await hub.close();
  }
});

test('session-start still prints the session id when the hub is down', async () => {
  const dead = new HubClient('http://127.0.0.1:1');
  const res = await runHook(
    'session-start',
    { session_id: 'sess-9', cwd: workspaceDir('p') },
    { client: dead, env: {} },
  );
  assert.match(parse(res.stdout).hookSpecificOutput?.additionalContext ?? '', /"sess-9"/);
});

test('pending nudges a provisional agent at prompt time and the hooks follow the window', async () => {
  const { hub, url } = await startTestHub();
  const client = new HubClient(url);
  try {
    const cwd = workspaceDir('w');
    hub.stores.agents.register({
      session_id: 'sess-p',
      name: 'repo',
      description: 'placeholder',
      capabilities: 'unknown',
      workspace: 'w',
      kind: 'agent',
      provisional: true,
      window: 'win-p',
    });
    const prompt = await runHook(
      'pending',
      { session_id: 'sess-p', cwd, hook_event_name: 'UserPromptSubmit' },
      { client, env: {} },
    );
    assert.match(
      parse(prompt.stdout).hookSpecificOutput?.additionalContext ?? '',
      /still registered provisionally as "repo"/,
    );
    const tool = await runHook(
      'pending',
      { session_id: 'sess-p', cwd, hook_event_name: 'PostToolUse', tool_name: 'Read' },
      { client, env: {} },
    );
    assert.equal(tool.stdout, '', 'tool calls never nag about identity');

    const switched = await runHook(
      'pending',
      { session_id: 'sess-after-clear', cwd, hook_event_name: 'UserPromptSubmit' },
      { client, env: {}, window: 'win-p' },
    );
    assert.match(parse(switched.stdout).hookSpecificOutput?.additionalContext ?? '', /"repo"/);
    assert.equal(hub.stores.agents.bySession('sess-after-clear')?.name, 'repo');

    const dormant = await runHook(
      'pending',
      {
        session_id: 'sess-p',
        cwd: mkdtempSync(join(tmpdir(), 'bare-')),
        hook_event_name: 'UserPromptSubmit',
      },
      { client: new HubClient('http://127.0.0.1:1'), env: {} },
    );
    assert.equal(dormant.stdout, '', 'no marker: no hub call, nothing printed');
  } finally {
    await hub.close();
  }
});

test('pending surfaces waiting messages once, skips agent-link tool calls, and stop blocks on open replies', async () => {
  const { hub, url } = await startTestHub();
  const client = new HubClient(url);
  // The designer has no edge, hence no channel subscription: the hook path is the only delivery.
  const profile = (name: string, kind: 'agent' | 'human' = 'agent') => ({
    session_id: `sess-${name}`,
    name,
    description: `${name} does things`,
    capabilities: 'consult',
    workspace: 'w',
    kind,
  });
  const architect = await openEdge(url, 'w');
  const cwd = architect.cwd;
  try {
    await architect.register('architect');
    const designer = await client.register(profile('designer'));
    const sent = await architect.call('send', {
      to: ['designer'],
      body: 'Please check the cache design when you can',
      expectation: 'reply',
    });
    const state = () =>
      hub.stores.messages.deliveryState(sent['message_id'] as string, designer.agent.id)?.state;

    const skipped = await runHook(
      'pending',
      {
        session_id: 'sess-designer',
        cwd,
        tool_name: 'mcp__plugin_agent-link_agent-link__inbox',
        hook_event_name: 'PostToolUse',
      },
      { client },
    );
    assert.equal(skipped.stdout, '');
    assert.equal(state(), 'queued');

    const first = await runHook(
      'pending',
      { session_id: 'sess-designer', cwd, tool_name: 'Read', hook_event_name: 'PostToolUse' },
      { client },
    );
    const out = parse(first.stdout);
    assert.equal(out.hookSpecificOutput?.hookEventName, 'PostToolUse');
    assert.match(
      out.hookSpecificOutput?.additionalContext ?? '',
      /1 message waiting.*\n- architect \(reply\) in cv_\w+: Please check/,
    );
    assert.equal(state(), 'notified');
    const second = await runHook(
      'pending',
      { session_id: 'sess-designer', cwd, hook_event_name: 'UserPromptSubmit' },
      { client },
    );
    assert.equal(second.stdout, '');

    const blocked = await runHook('stop', { session_id: 'sess-designer', cwd }, { client });
    const b = parse(blocked.stdout);
    assert.equal(b.decision, 'block');
    assert.match(b.reason ?? '', /1 peer is waiting for your reply/);
    assert.equal(state(), 'notified', 'stop never changes delivery state');

    const active = await runHook(
      'stop',
      { session_id: 'sess-designer', cwd, stop_hook_active: true },
      { client },
    );
    assert.equal(active.stdout, '');
    const nothingOpen = await runHook('stop', { session_id: architect.sessionId, cwd }, { client });
    assert.equal(nothingOpen.stdout, '');

    await client.send(designer.token, {
      conversation_id: sent['conversation_id'] as string,
      body: 'Looks good',
      expectation: 'none',
      final: false,
    });
    const answered = await runHook('stop', { session_id: 'sess-designer', cwd }, { client });
    assert.equal(answered.stdout, '');

    await client.register(profile('dana', 'human'));
    await architect.call('send', { to: ['dana'], body: 'Approve?', expectation: 'reply' });
    const humanStop = await runHook('stop', { session_id: 'sess-dana', cwd }, { client });
    assert.equal(humanStop.stdout, '', 'a human relay is never blocked');

    const end = await runHook('session-end', { session_id: 'sess-designer', cwd }, { client });
    assert.equal(end.exitCode, 0);
    assert.equal(hub.stores.agents.byName('w', 'designer'), undefined);
  } finally {
    await architect.close();
    await hub.close();
  }
});

test('every hook is silent and quick when the hub is unreachable', async () => {
  const dead = new HubClient('http://127.0.0.1:1');
  for (const event of ['pending', 'stop', 'session-end', 'bogus']) {
    const t0 = Date.now();
    const res = await runHook(
      event,
      { session_id: 's', hook_event_name: 'PostToolUse' },
      { client: dead },
    );
    assert.deepEqual(res, { stdout: '', exitCode: 0 }, event);
    assert.ok(Date.now() - t0 < 1000, `${event} took too long`);
  }
});

test('the binary runs hooks from stdin and exits 0 even without a hub', async () => {
  const bin = fileURLToPath(new URL('./bin.ts', import.meta.url));
  const child = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', bin, 'hook', 'pending'],
    {
      env: { ...process.env, AGENT_LINK_HUB: 'http://127.0.0.1:1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.end(
    JSON.stringify({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read' }),
  );
  let stdout = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  const code = await new Promise<number | null>((r) => child.on('exit', r));
  assert.equal(code, 0);
  assert.equal(stdout, '');

  const version = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', bin, '--version']);
  let v = '';
  version.stdout.on('data', (c: Buffer) => (v += c.toString()));
  await new Promise((r) => version.on('exit', r));
  assert.match(v, /^agent-link-edge \d+\.\d+\.\d+/);
});

test('the session-start hook starts the hub itself when none answers', async () => {
  const bin = fileURLToPath(new URL('./bin.ts', import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-link-hook-hub-'));
  const port = await new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', bin, 'hook', 'session-start'],
    {
      env: { ...process.env, AGENT_LINK_HUB: url, AGENT_LINK_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.end(JSON.stringify({ session_id: 's-boot', cwd: workspaceDir('boot') }));
  let stdout = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  const code = await new Promise<number | null>((r) => child.on('exit', r));
  try {
    assert.equal(code, 0);
    assert.match(parse(stdout).hookSpecificOutput?.additionalContext ?? '', /workspace "boot"/);
    const health = await fetch(`${url}/v1/health`);
    assert.equal(health.status, 200, 'the hook left a running hub behind');
    const recorded = (await (
      await fetch(`${url}/v1/sessions`, {
        method: 'POST',
        body: JSON.stringify({ session_id: 's-boot' }),
      })
    ).json()) as { session: { workspace_hint: string | null } };
    assert.equal(recorded.session.workspace_hint, 'boot', 'the upsert reached the hub');
  } finally {
    const hubJson = join(dataDir, 'hub.json');
    if (existsSync(hubJson)) {
      const { pid } = JSON.parse(readFileSync(hubJson, 'utf8')) as { pid: number };
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
});

test('session-start warns when the window was started without the channels flag', async () => {
  const { hub, url } = await startTestHub();
  const client = new HubClient(url);
  try {
    const cwd = workspaceDir('proj');
    const warned = await runHook(
      'session-start',
      { session_id: 'sess-nc', cwd, source: 'startup' },
      { client, env: {}, window: 'win-nc', channel: false },
    );
    assert.match(
      parse(warned.stdout).hookSpecificOutput?.additionalContext ?? '',
      /Warning: this window was started without --dangerously-load-development-channels plugin:agent-link@agent-link/,
    );
    const fine = await runHook(
      'session-start',
      { session_id: 'sess-c', cwd, source: 'startup' },
      { client, env: {}, window: 'win-c', channel: true },
    );
    assert.doesNotMatch(parse(fine.stdout).hookSpecificOutput?.additionalContext ?? '', /Warning/);
  } finally {
    await hub.close();
  }
});
