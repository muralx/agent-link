import {
  SessionUpsertRequestSchema,
  type Agent,
  type HookAgent,
  type OpenResponse,
  type PendingResponse,
  type SessionUpsertResponse,
} from '@agent-link/protocol';
import { takeOffline, type HubDeps } from '../deps.ts';
import { SYSTEM_SESSION_PREFIX } from '../store/agents.ts';

/** hookAgent reduces an agent to the slice the hooks receive. */
function hookAgent(agent: Agent): HookAgent {
  return { name: agent.name, kind: agent.kind, provisional: agent.provisional };
}

/**
 * resolveSessionAgent finds the agent a hook's session belongs to. A window id
 * wins: the online agent of that Claude Code window is relinked to the session
 * id when the window switched sessions (/clear, /resume). Otherwise the agent
 * bound to the session id is used. Returns the agent (or undefined) and, when a
 * relink happened, the different agent the session id was bound to before. A
 * reserved system session id never resolves to an agent.
 */
function resolveSessionAgent(
  deps: HubDeps,
  sessionId: string,
  window: string | undefined,
): { agent: Agent | undefined; previous: Agent | undefined } {
  const { agents } = deps.stores;
  if (sessionId.startsWith(SYSTEM_SESSION_PREFIX)) return { agent: undefined, previous: undefined };
  const bySession = agents.bySession(sessionId);
  if (window) {
    const byWindow = agents.byWindow(window);
    if (byWindow && byWindow.status === 'online' && byWindow.id !== bySession?.id) {
      agents.relinkSession(byWindow.id, sessionId);
      deps.stores.sessions.linkAgent(sessionId, byWindow.id);
      return { agent: agents.byId(byWindow.id), previous: bySession };
    }
  }
  return { agent: bySession, previous: undefined };
}

/**
 * registerSessionRoutes adds the unauthenticated, session-scoped routes the
 * hooks use: POST /v1/sessions (upsert, reports the agent if any), GET
 * /v1/sessions/:id/pending (surfaces and marks pending deliveries, lists open
 * replies), GET /v1/sessions/:id/open (read-only agent kind and open replies
 * for the Stop hook) and POST /v1/sessions/:id/end (takes the agent offline
 * unless its edge still holds a stream, in which case the window merely switched
 * sessions). Every route accepts the hook's window id (body field or ?window=)
 * to follow an agent across session switches. Unknown sessions get empty
 * answers, never errors.
 */
export function registerSessionRoutes(deps: HubDeps): void {
  const { router, stores } = deps;

  router.add('POST', '/v1/sessions', async ({ parseJson }) => {
    const input = await parseJson(SessionUpsertRequestSchema);
    stores.sessions.upsert(input);
    const { agent, previous } = resolveSessionAgent(deps, input.session_id, input.window);
    const body: SessionUpsertResponse = {
      session: stores.sessions.get(input.session_id)!,
      agent: agent ?? null,
      previous: previous ?? null,
    };
    return { body };
  });

  router.add('GET', '/v1/sessions/:id/pending', ({ params, query }) => {
    const { agent } = resolveSessionAgent(
      deps,
      params['id'] ?? '',
      query.get('window') ?? undefined,
    );
    const body: PendingResponse = agent
      ? {
          agent: hookAgent(agent),
          messages: stores.messages.pendingForHook(agent.id),
          open_replies: stores.messages.openReplies(agent.id),
        }
      : { agent: null, messages: [], open_replies: [] };
    return { body };
  });

  router.add('GET', '/v1/sessions/:id/open', ({ params, query }) => {
    const { agent } = resolveSessionAgent(
      deps,
      params['id'] ?? '',
      query.get('window') ?? undefined,
    );
    const body: OpenResponse = agent
      ? { agent: hookAgent(agent), open_replies: stores.messages.openReplies(agent.id) }
      : { agent: null, open_replies: [] };
    return { body };
  });

  router.add('POST', '/v1/sessions/:id/end', ({ params, query }) => {
    const { agent } = resolveSessionAgent(
      deps,
      params['id'] ?? '',
      query.get('window') ?? undefined,
    );
    if (agent && !deps.presence.isConnected(agent.id)) {
      deps.presence.forget(agent.id);
      takeOffline(deps, agent.id);
    }
    return undefined;
  });
}
