import type { ServerResponse } from 'node:http';
import { DeliveryAckRequestSchema, type AwaitResponse, type HubEvent } from '@agent-link/protocol';
import { requireAgent } from '../auth.ts';
import type { HubDeps } from '../deps.ts';
import { now } from '../store/db.ts';
import type { QueuedMessage } from '../store/messages.ts';

/**
 * AWAIT_SLICE_MAX_S caps one await request at 25 s; the edge chains requests to
 * honour longer tool timeouts.
 */
export const AWAIT_SLICE_MAX_S = 25;

/**
 * eventId builds the SSE id of a message event as created_at|message id, so ids
 * order by time and a client can resume with Last-Event-ID.
 */
export function eventId(message: { created_at: string; id: string }): string {
  return `${message.created_at}|${message.id}`;
}

/**
 * writeFrame writes one SSE frame with id, event name (the HubEvent type) and
 * the JSON event as data.
 */
function writeFrame(res: ServerResponse, id: string, event: HubEvent): void {
  res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** toEvent wraps a queued message as a message HubEvent. */
function toEvent(q: QueuedMessage): HubEvent {
  return { type: 'message', message: q.message, subject: q.subject, participants: q.participants };
}

/**
 * registerStreamRoutes adds the delivery routes. GET /v1/agents/:id/events is
 * the SSE stream: headers are flushed immediately so a client's fetch resolves
 * on an idle stream, still-queued deliveries are replayed (skipping ids at or
 * before Last-Event-ID), then live message and peer events follow with a
 * keepalive comment every keepaliveMs; connect and close drive presence. GET
 * /v1/agents/:id/await long-polls for at most AWAIT_SLICE_MAX_S seconds and
 * returns the agent's unread messages matching the conversation/message filters
 * as soon as any exist, marking them read via await. POST
 * /v1/deliveries/:msg/:agent applies a delivery ack.
 */
export function registerStreamRoutes(deps: HubDeps): void {
  const { router, stores, bus, presence } = deps;

  router.add('GET', '/v1/agents/:id/events', ({ req, res, params }) => {
    const agent = requireAgent(stores.agents, req, params['id'] ?? '');
    const lastEventId = req.headers['last-event-id'];
    const after = typeof lastEventId === 'string' ? lastEventId : undefined;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    for (const queued of stores.messages.queuedFor(agent.id)) {
      const id = eventId(queued.message);
      if (after !== undefined && id <= after) continue;
      writeFrame(res, id, toEvent(queued));
    }

    const unsubscribe = bus.subscribe(agent.id, (event) => {
      const id = event.type === 'message' ? eventId(event.message) : `${now()}|peer`;
      writeFrame(res, id, event);
    });
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), deps.keepaliveMs);
    presence.connected(agent.id);
    stores.agents.touch(agent.id);

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(keepalive);
      deps.streams.delete(close);
      presence.disconnected(agent.id);
      res.end();
    };
    deps.streams.add(close);
    req.on('close', close);
    res.on('close', close);
  });

  router.add('GET', '/v1/agents/:id/await', async ({ req, params, query }) => {
    const agent = requireAgent(stores.agents, req, params['id'] ?? '');
    const requested = Number.parseInt(query.get('timeout_s') ?? '', 10);
    const timeoutS = Number.isNaN(requested)
      ? AWAIT_SLICE_MAX_S
      : Math.min(AWAIT_SLICE_MAX_S, Math.max(1, requested));
    const filter = {
      conversationId: query.get('conversation') ?? undefined,
      afterMessageId: query.get('message') ?? undefined,
    };
    const deadline = Date.now() + timeoutS * 1000;
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    stores.agents.touch(agent.id);

    for (;;) {
      const found = stores.messages.unreadFor(agent.id, filter);
      if (found.length > 0) {
        stores.messages.markRead(
          agent.id,
          found.map((m) => m.id),
          'await',
        );
        const body: AwaitResponse = { messages: found, timed_out: false };
        return { body };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || controller.signal.aborted) {
        const body: AwaitResponse = { messages: [], timed_out: true };
        return { body };
      }
      const event = await bus.waitFor(agent.id, remaining, controller.signal);
      if (event === undefined) {
        const body: AwaitResponse = { messages: [], timed_out: true };
        return { body };
      }
    }
  });

  router.add('POST', '/v1/deliveries/:msg/:agent', async ({ req, params, parseJson }) => {
    const agent = requireAgent(stores.agents, req, params['agent'] ?? '');
    const input = await parseJson(DeliveryAckRequestSchema);
    stores.messages.ack(params['msg'] ?? '', agent.id, input.state, input.via);
    return undefined;
  });
}
