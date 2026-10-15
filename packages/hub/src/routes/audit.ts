import type {
  AuditConversationsResponse,
  AuditFeedResponse,
  ConversationResponse,
} from '@agent-link/protocol';
import type { HubDeps } from '../deps.ts';
import { auditKey } from '../guard.ts';
import { requireRole } from './guard.ts';
import { AWAIT_SLICE_MAX_S } from './stream.ts';

/**
 * registerAuditRoutes adds the read-only audit view of a workspace, open to its
 * humans and watchers only. GET /v1/workspaces/:ws/audit/conversations lists
 * every conversation; GET .../audit/conversations/:id returns one thread; GET
 * .../audit/messages is the message feed after ?since= (a message id; absent
 * means start from now), at most ?limit= (default 50, max 200), long-polling up
 * to ?wait_s= seconds (capped at AWAIT_SLICE_MAX_S) while there is nothing new.
 * None of them changes delivery state.
 */
export function registerAuditRoutes(deps: HubDeps): void {
  const { router, stores, bus } = deps;

  router.add('GET', '/v1/workspaces/:ws/audit/conversations', ({ req, params }) => {
    const observer = requireRole(deps, req, params['ws'] ?? '', true);
    const body: AuditConversationsResponse = stores.audit.conversations(observer.workspace);
    return { body };
  });

  router.add('GET', '/v1/workspaces/:ws/audit/conversations/:id', ({ req, params }) => {
    const observer = requireRole(deps, req, params['ws'] ?? '', true);
    const body: ConversationResponse = stores.audit.thread(observer.workspace, params['id'] ?? '');
    return { body };
  });

  router.add('GET', '/v1/workspaces/:ws/audit/messages', async ({ req, params, query }) => {
    const observer = requireRole(deps, req, params['ws'] ?? '', true);
    const since = query.get('since') ?? undefined;
    const limit = clamp(query.get('limit'), 50, 1, 200);
    const deadline = Date.now() + clamp(query.get('wait_s'), 0, 0, AWAIT_SLICE_MAX_S) * 1000;
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    stores.agents.touch(observer.id);

    for (;;) {
      const page = stores.audit.feed(observer.workspace, since, limit);
      const remaining = deadline - Date.now();
      const waitable = since !== undefined && page.messages.length === 0;
      if (!waitable || remaining <= 0 || controller.signal.aborted) {
        const body: AuditFeedResponse = { ...page, timed_out: waitable };
        return { body };
      }
      await bus.waitFor(auditKey(observer.workspace), remaining, controller.signal);
    }
  });
}

/**
 * clamp parses an integer query parameter into [min, max], falling back when
 * absent or not a number.
 */
function clamp(value: string | null, fallback: number, min: number, max: number): number {
  const n = value === null ? NaN : Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
