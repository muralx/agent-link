#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '@agent-link/hub';
import { resolveHubUrl, resolveWorkspace } from './config.ts';
import { runHook, type HookInput } from './hook.ts';
import { HubClient } from './hub-client.ts';
import { ensureHub } from './hub-launcher.ts';
import { createEdgeServer, EDGE_VERSION } from './mcp-server.ts';
import { channelEnabled, currentWindowId } from './window.ts';

/** readStdin collects all of stdin as UTF-8 text. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * HOOK_HUB_START_MS bounds how long the SessionStart hook waits for the hub it
 * (or the edge, racing it under the same lock) starts, so the hook's context
 * can describe the window's agent (3 s; the plugin gives hooks 5 s).
 */
const HOOK_HUB_START_MS = 3000;

/**
 * hook reads the hook JSON from stdin, runs the named hook against the
 * configured hub with this process's window id and channel state and exits with its result; it
 * never exits non-zero. On SessionStart in an enabled location it first makes
 * sure a hub is up, since the edge is starting at the same moment and the
 * hook's context is better with the agent's state in it.
 */
async function hook(event: string): Promise<void> {
  const input = await readStdin()
    .then((raw) => (raw.trim() === '' ? {} : (JSON.parse(raw) as HookInput)))
    .catch((): HookInput => ({}));
  const url = resolveHubUrl();
  const cwd = input.cwd ?? process.cwd();
  if (event === 'session-start' && resolveWorkspace(cwd) !== undefined) {
    await ensureHub({ url, dataDir: loadConfig().dataDir, timeoutMs: HOOK_HUB_START_MS }).catch(
      () => undefined,
    );
  }
  const client = new HubClient(url);
  const result = await runHook(event, input, {
    client,
    cwd,
    window: currentWindowId(),
    channel: channelEnabled(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}

/**
 * serve is the MCP server mode: resolves the hub URL, derives this process's
 * window id and channel state (currentWindowId, channelEnabled), connects the
 * edge server to stdio and then starts it, which in an enabled location (a
 * workspace resolves from cwd) starts the hub if none answers and registers
 * this window provisionally so peers can reach it at once; elsewhere the edge
 * stays dormant until a tool is called. Exits when the transport closes.
 */
async function serve(): Promise<void> {
  const url = resolveHubUrl();
  const dataDir = loadConfig().dataDir;
  const ensure = (): Promise<void> => ensureHub({ url, dataDir });
  const edge = createEdgeServer({
    client: new HubClient(url),
    cwd: process.cwd(),
    window: currentWindowId(),
    channel: channelEnabled(),
    ensureHub: ensure,
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void edge.close().finally(() => process.exit(0));
  };
  await edge.server.connect(transport);
  await edge.start();
}

const [, , command, argument] = process.argv;
if (command === '--version' || command === '-v') {
  process.stdout.write(`agent-link-edge ${EDGE_VERSION}\n`);
} else if (command === 'hook') {
  hook(argument ?? '').catch(() => process.exit(0));
} else {
  serve().catch((err: unknown) => {
    process.stderr.write(
      `agent-link-edge failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
