import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Notification,
  type Request,
  type Result,
} from '@modelcontextprotocol/sdk/types.js';
import { basename } from 'node:path';
import type { Env } from '@agent-link/hub';
import { emitChannel, type ChannelNotification } from './channel.ts';
import { resolveWorkspace } from './config.ts';
import type { HubClient } from './hub-client.ts';
import { SERVER_INSTRUCTIONS } from './instructions.ts';
import { EdgeSession, type Identity } from './session.ts';
import { callTool, toolListing, type ToolContext } from './tools.ts';

/** EDGE_VERSION is the MCP server version advertised at initialize. */
export const EDGE_VERSION = '0.1.0';

/**
 * EdgeServerOptions configures createEdgeServer: hub client, working directory
 * and environment (CLAUDE_CODE_SESSION_ID and CLAUDE_PROJECT_DIR are read from
 * it), the Claude Code window id and channel state when known, an optional
 * ensureHub for hub start and recovery, and an error sink (stderr by default).
 */
export interface EdgeServerOptions {
  client: HubClient;
  cwd: string;
  env?: Env | undefined;
  /**
   * window is this process's Claude Code window id (currentWindowId), sent with
   * registrations so the hub can reconnect the agent after a session switch.
   */
  window?: string | undefined;
  /**
   * channel is whether Claude Code accepts channel notifications from this
   * server (channelEnabled): false suppresses them so deliveries stay queued for
   * the hooks; true or undefined (unknown) emits them.
   */
  channel?: boolean | undefined;
  ensureHub?: (() => Promise<void>) | undefined;
  onError?: ((err: unknown) => void) | undefined;
}

/**
 * provisionalName derives the placeholder agent name for an automatic
 * registration from the project directory's basename: runs of disallowed
 * characters become '-', leading and trailing non-alphanumerics are dropped, at
 * most 64 characters, 'session' when nothing usable remains.
 */
export function provisionalName(dir: string): string {
  const cleaned = basename(dir)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .slice(0, 64);
  return cleaned === '' ? 'session' : cleaned;
}

/**
 * PROVISIONAL_DESCRIPTION is the placeholder profile of an automatic
 * registration; peers see it until the model identifies itself.
 */
export const PROVISIONAL_DESCRIPTION =
  'Claude Code session that has not identified itself yet. It will introduce itself with its real name and role; a message sent now wakes it and is answered after that.';

/**
 * EdgeMcpServer is the SDK Server type widened so it can send
 * ChannelNotification.
 */
export type EdgeMcpServer = Server<Request, ChannelNotification & Notification, Result>;

/**
 * EdgeServer is the created edge: the MCP server to connect to a transport, the
 * session state, start() which performs the automatic provisional registration
 * once the transport is connected, and close() which stops the subscription and
 * the server.
 */
export interface EdgeServer {
  server: EdgeMcpServer;
  session: EdgeSession;
  /**
   * start performs the automatic provisional registration: when a workspace
   * resolves from cwd and a session id is known (CLAUDE_CODE_SESSION_ID, else a
   * window placeholder) it ensures the hub, registers a placeholder identity
   * for this window and opens the channel subscription, returning the identity.
   * It returns undefined and stays dormant when the location is not enabled,
   * and reports (not throws) hub failures through onError so a later tool call
   * can recover. Call it after the transport is connected so channel
   * notifications are not lost.
   */
  start(): Promise<Identity | undefined>;
  close(): Promise<void>;
}

/**
 * createEdgeServer builds the edge's MCP Server (SDK 1.x) named agent-link with
 * tools and the experimental claude/channel capability, the
 * SERVER_INSTRUCTIONS, tools/list from toolListing and tools/call through
 * callTool (progress notifications when the request carries a progressToken,
 * abort via the request signal). Tool results are serialised as compact JSON.
 * It reads CLAUDE_CODE_SESSION_ID and CLAUDE_PROJECT_DIR from the environment
 * for the edge's own session id and provisional name. After any successful
 * registration (start or the register tool) it (re)starts the SSE subscription
 * that feeds emitChannel with options.channel and the session's awaited check:
 * when channel is false no notification is emitted and deliveries stay queued
 * for the hooks, and a message an await returns, or will return, is not pushed
 * as well. It does not connect a transport; the caller does, then calls
 * start().
 */
export function createEdgeServer(options: EdgeServerOptions): EdgeServer {
  const session = new EdgeSession();
  const server: EdgeMcpServer = new Server(
    { name: 'agent-link', version: EDGE_VERSION },
    {
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  const onError =
    options.onError ??
    ((err: unknown) => process.stderr.write(`agent-link-edge: ${String(err)}\n`));

  const onRegistered = (identity: Identity): void => {
    session.replaceSubscription(
      options.client.subscribeEvents(identity.agentId, identity.token, {
        onEvent: (event) => {
          emitChannel(server, options.client, identity, event, options.channel, (e) =>
            session.awaited(e.message.conversation_id, e.message.id),
          ).catch(onError);
        },
        onError,
      }),
    );
  };

  const env = options.env ?? process.env;
  const ensureHub = options.ensureHub ?? (() => Promise.resolve());
  const sessionId =
    env['CLAUDE_CODE_SESSION_ID'] ?? (options.window ? `window:${options.window}` : undefined);
  const baseContext: Omit<ToolContext, 'progress' | 'signal'> = {
    client: options.client,
    session,
    cwd: options.cwd,
    env,
    sessionId,
    window: options.window,
    channel: options.channel,
    onRegistered,
    ensureHub,
  };

  const start = async (): Promise<Identity | undefined> => {
    const workspace = resolveWorkspace(options.cwd, env);
    if (!workspace || !sessionId) return undefined;
    try {
      await ensureHub();
      const registration = await options.client.register({
        session_id: sessionId,
        name: provisionalName(env['CLAUDE_PROJECT_DIR'] ?? options.cwd),
        description: PROVISIONAL_DESCRIPTION,
        capabilities: 'unknown until it identifies itself',
        workspace,
        kind: 'agent',
        provisional: true,
        cwd: options.cwd,
        ...(options.window ? { window: options.window } : {}),
      });
      const identity = session.adopt(sessionId, registration);
      onRegistered(identity);
      return identity;
    } catch (err) {
      onError(err);
      return undefined;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolListing() }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const progressToken = request.params._meta?.progressToken;
      const progress =
        progressToken === undefined
          ? undefined
          : (step: number) =>
              extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: step },
              });
      const outcome = await callTool(request.params.name, request.params.arguments ?? {}, {
        ...baseContext,
        progress,
        signal: extra.signal,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
        isError: outcome.isError,
      };
    },
  );

  return {
    server,
    session,
    start,
    async close() {
      session.clear();
      await server.close();
    },
  };
}
