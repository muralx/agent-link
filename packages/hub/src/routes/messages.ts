import {
  SendInputSchema,
  type ConversationResponse,
  type ConversationsResponse,
  type InboxResponse,
  type SendResponse,
} from '@agent-link/protocol';
import { authenticate, requireAgent } from '../auth.ts';
import type { HubDeps } from '../deps.ts';
import { enforce, publishMessage } from '../guard.ts';

/**
 * flag parses a boolean query parameter ('true' or '1'), falling back when
 * absent.
 */
function flag(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value === 'true' || value === '1';
}

/**
 * int parses an integer query parameter clamped to [min, max], falling back
 * when absent or not a number.
 */
function int(value: string | null, fallback: number, min: number, max: number): number {
  const n = value === null ? NaN : Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * registerMessageRoutes adds the authenticated message routes: POST
 * /v1/messages (the guard's enforce first, which refuses a quarantined sender
 * and quarantines one that breaks a rule; then send or reply via
 * MessageStore.send, and a message event is published to every recipient id
 * and to the workspace audit feed), GET /v1/agents/:id/inbox (unread_only,
 * limit), GET /v1/agents/:id/conversations (open_only) and GET
 * /v1/conversations/:id (since = message id).
 */
export function registerMessageRoutes(deps: HubDeps): void {
  const { router, stores } = deps;

  router.add('POST', '/v1/messages', async ({ req, parseJson }) => {
    const agent = authenticate(stores.agents, req);
    const input = await parseJson(SendInputSchema);
    enforce(deps, agent, { to: input.to, body: input.body, conversationId: input.conversation_id });
    const result = stores.messages.send({
      fromId: agent.id,
      to: input.to,
      body: input.body,
      expectation: input.expectation,
      subject: input.subject,
      conversationId: input.conversation_id,
      inReplyTo: input.in_reply_to,
      final: input.final,
    });
    stores.agents.touch(agent.id);
    publishMessage(deps, agent.workspace, result.recipientIds, result);
    const body: SendResponse = {
      message_id: result.message_id,
      conversation_id: result.conversation_id,
      delivered_to: result.delivered_to,
      offline: result.offline,
    };
    return { status: 201, body };
  });

  router.add('GET', '/v1/agents/:id/inbox', ({ req, params, query }) => {
    const agent = requireAgent(stores.agents, req, params['id'] ?? '');
    const body: InboxResponse = {
      messages: stores.messages.inbox(agent.id, {
        unreadOnly: flag(query.get('unread_only'), true),
        limit: int(query.get('limit'), 50, 1, 200),
      }),
    };
    return { body };
  });

  router.add('GET', '/v1/agents/:id/conversations', ({ req, params, query }) => {
    const agent = requireAgent(stores.agents, req, params['id'] ?? '');
    const body: ConversationsResponse = stores.messages.listForAgent(
      agent.id,
      flag(query.get('open_only'), false),
    );
    return { body };
  });

  router.add('GET', '/v1/conversations/:id', ({ req, params, query }) => {
    const agent = authenticate(stores.agents, req);
    const since = query.get('since') ?? undefined;
    const thread = stores.messages.thread(agent.id, params['id'] ?? '', since);
    const body: ConversationResponse = thread;
    return { body };
  });
}
