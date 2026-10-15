import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HealthResponse } from '@agent-link/protocol';
import { EventBus } from './events.ts';
import { Router } from './http.ts';
import { PresenceTracker, DEFAULT_GRACE_MS } from './presence.ts';
import { takeOffline, type HubDeps, type Stores } from './deps.ts';
import { registerAgentRoutes } from './routes/agents.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerGuardRoutes } from './routes/guard.ts';
import { registerMessageRoutes } from './routes/messages.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerStreamRoutes } from './routes/stream.ts';
import { AgentStore } from './store/agents.ts';
import { AuditStore } from './store/audit.ts';
import { ConversationStore } from './store/conversations.ts';
import { openDatabase } from './store/db.ts';
import { DEFAULT_GUARD_LIMITS, GuardStore, type GuardLimits } from './store/guard.ts';
import { MessageStore } from './store/messages.ts';
import { SessionStore } from './store/sessions.ts';
import { HUB_VERSION } from './version.ts';

/**
 * DEFAULT_KEEPALIVE_MS is the SSE comment interval that keeps idle streams
 * alive (15 s).
 */
export const DEFAULT_KEEPALIVE_MS = 15_000;

/**
 * HubOptions configures createHub: the database path (':memory:' for tests),
 * bind host and port, SSE keepalive interval, presence grace period and guard:
 * false switches the guard's automatic rules off, an object overrides some of
 * DEFAULT_GUARD_LIMITS, absent means the defaults.
 */
export interface HubOptions {
  dbPath: string;
  port?: number;
  host?: string;
  keepaliveMs?: number;
  graceMs?: number;
  /**
   * guard false switches the automatic rules off; an object overrides some of
   * DEFAULT_GUARD_LIMITS; absent means the defaults.
   */
  guard?: Partial<GuardLimits> | false;
}

/**
 * Hub is a created but not necessarily listening hub: listen() binds and
 * returns the base URL, close() ends streams, timers, connections and the
 * database. stores, bus and presence are test and diagnostic handles.
 */
export interface Hub {
  listen(): Promise<string>;
  close(): Promise<void>;
  readonly url: string | undefined;
  readonly stores: Stores;
  readonly bus: EventBus;
  readonly presence: PresenceTracker;
  closeStreams(): void;
}

/**
 * createHub builds a hub over the SQLite file at dbPath with all stores, the
 * event bus, presence and every route group (health, sessions, agents,
 * messages, stream, guard, audit) wired, bound to host:port on listen() (port 0 picks a free
 * one). close() stops accepting connections first, then ends open SSE streams,
 * presence timers and remaining connections, and closes the database. The
 * returned Hub exposes stores, bus, presence and closeStreams for in-process
 * tests; the binary uses only listen, close and url.
 */
export function createHub(options: HubOptions): Hub {
  const db = openDatabase(options.dbPath);
  const agents = new AgentStore(db);
  const conversations = new ConversationStore(db);
  const stores: Stores = {
    agents,
    sessions: new SessionStore(db),
    conversations,
    messages: new MessageStore(db, agents, conversations),
    guard: new GuardStore(db, { ...DEFAULT_GUARD_LIMITS, ...(options.guard || {}) }),
    audit: new AuditStore(db, conversations),
  };
  const router = new Router();
  const bus = new EventBus();
  const deps: HubDeps = {
    router,
    stores,
    bus,
    presence: new PresenceTracker(
      (id) => takeOffline(deps, id),
      options.graceMs ?? DEFAULT_GRACE_MS,
    ),
    keepaliveMs: options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS,
    streams: new Set(),
    guardRules: options.guard !== false,
  };

  router.add('GET', '/v1/health', () => {
    const body: HealthResponse = { ok: true, version: HUB_VERSION, pid: process.pid };
    return { body };
  });
  registerSessionRoutes(deps);
  registerAgentRoutes(deps);
  registerMessageRoutes(deps);
  registerStreamRoutes(deps);
  registerGuardRoutes(deps);
  registerAuditRoutes(deps);

  const server: Server = createServer((req, res) => void router.handle(req, res));
  let url: string | undefined;

  return {
    get url() {
      return url;
    },
    stores,
    bus,
    presence: deps.presence,
    closeStreams() {
      for (const close of [...deps.streams]) close();
    },
    async listen() {
      await new Promise<void>((resolve) =>
        server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve),
      );
      const addr = server.address() as AddressInfo;
      url = `http://${addr.address}:${addr.port}`;
      return url;
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      this.closeStreams();
      deps.presence.close();
      server.closeAllConnections();
      await closed;
      db.close();
    },
  };
}
