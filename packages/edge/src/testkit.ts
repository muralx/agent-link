import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHub, type Hub } from '@agent-link/hub';
import { HubClient } from './hub-client.ts';
import { createEdgeServer, type EdgeServer } from './mcp-server.ts';

/**
 * TestEdge bundles a test edge's client, server, cwd, session id and helpers.
 */
export interface TestEdge {
  client: Client;
  edge: EdgeServer;
  cwd: string;
  sessionId: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  register: (name: string) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

/**
 * workspaceDir creates a temp tree whose root holds .agent-link.json for the
 * workspace and returns a subdirectory as the session cwd.
 */
export function workspaceDir(workspace: string): string {
  const root = mkdtempSync(join(tmpdir(), `agent-link-${workspace}-`));
  writeFileSync(join(root, '.agent-link.json'), JSON.stringify({ workspace }));
  const cwd = join(root, 'src');
  mkdirSync(cwd);
  return cwd;
}

/** startTestHub starts an in-memory hub on an ephemeral port for edge tests. */
export async function startTestHub(): Promise<{ hub: Hub; url: string }> {
  const hub = createHub({ dbPath: ':memory:', port: 0, keepaliveMs: 60_000 });
  const url = await hub.listen();
  return { hub, url };
}

/**
 * openEdge creates an edge connected to an in-memory MCP client, with a fresh
 * temp workspace directory (or the given cwd), an empty environment unless env
 * is given (so no automatic registration happens by default), an optional
 * window id, channel state and error sink, and returns helpers to call tools
 * and register.
 */
export async function openEdge(
  hubUrl: string,
  workspace: string,
  options: {
    ensureHub?: () => Promise<void>;
    hubClient?: HubClient;
    cwd?: string;
    env?: Record<string, string | undefined>;
    window?: string;
    channel?: boolean;
    onError?: (err: unknown) => void;
  } = {},
): Promise<TestEdge> {
  const cwd = options.cwd ?? workspaceDir(workspace);
  const edge = createEdgeServer({
    client: options.hubClient ?? new HubClient(hubUrl),
    cwd,
    env: options.env ?? {},
    window: options.window,
    channel: options.channel,
    ensureHub: options.ensureHub,
    onError: options.onError ?? (() => undefined),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await edge.server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  const sessionId = `session-${workspace}-${Math.random().toString(36).slice(2, 8)}`;
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as { type: string; text: string }[];
    return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
  };
  return {
    client,
    edge,
    cwd,
    sessionId,
    call,
    register: (name: string) =>
      call('register', {
        session_id: sessionId,
        name,
        description: `${name} does things`,
        capabilities: 'consult',
      }),
    close: async () => {
      await client.close();
      await edge.close();
    },
  };
}
