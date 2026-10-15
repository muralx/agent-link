import type { HubEvent } from '@agent-link/protocol';
import type { HubClient } from './hub-client.ts';
import type { Identity } from './session.ts';

/** CHANNEL_METHOD is the Claude Code channel notification method name. */
export const CHANNEL_METHOD = 'notifications/claude/channel';

/**
 * IDENTIFY_FIRST is appended to a message delivered to a still provisional
 * agent: it must register its real identity before replying.
 */
export const IDENTIFY_FIRST =
  '[agent-link] You are still registered provisionally under a placeholder name. Before you reply, call register with your real name, what you are responsible for and what peers may ask you for (infer them from this session; ask the user for a name only if you cannot).';

/**
 * ChannelNotification is the shape of the notifications/claude/channel
 * notification: content plus optional string meta.
 */
export interface ChannelNotification {
  method: typeof CHANNEL_METHOD;
  params: { content: string; meta?: Record<string, string> };
}

/**
 * ChannelSink is the part of the MCP Server emitChannel needs: notification().
 */
export interface ChannelSink {
  notification(notification: ChannelNotification): Promise<void>;
}

/**
 * describeExpectation maps an expectation to the short phrase shown in the
 * channel header.
 */
function describeExpectation(expectation: string): string {
  switch (expectation) {
    case 'reply':
      return 'expects reply';
    case 'updates':
      return 'wants updates';
    default:
      return 'fyi';
  }
}

/**
 * renderChannelContent formats the channel text: for a message, 'from → you
 * (expects reply | wants updates | fyi) in conversation id «subject» [final]:'
 * followed by the body; for a peer join, 'peer joined: name (human)
 * (provisional, not yet identified) — description'; for an identification,
 * 'peer identified: name (was old) — description'; undefined for a peer leave.
 */
export function renderChannelContent(event: HubEvent): string | undefined {
  if (event.type === 'peer') {
    if (event.event === 'left') return undefined;
    const kind = event.kind === 'human' ? ' (human)' : '';
    if (event.event === 'updated') {
      const was =
        event.previous_name && event.previous_name !== event.name
          ? ` (was ${event.previous_name})`
          : '';
      return `peer identified: ${event.name}${kind}${was} — ${event.description}`;
    }
    const state = event.provisional ? ' (provisional, not yet identified)' : '';
    return `peer joined: ${event.name}${kind}${state} — ${event.description}`;
  }
  const { message, subject } = event;
  const head = `${message.from} → you (${describeExpectation(message.expectation)}) in conversation ${message.conversation_id}`;
  const title = subject ? ` «${subject}»` : '';
  const tail = message.final ? ' [final]' : '';
  return `${head}${title}${tail}:\n\n${message.body}`;
}

/**
 * channelMeta builds the channel meta attributes (all string values, identifier
 * keys as the channel contract requires): conversation_id, message_id, from,
 * expectation and final for a message; peer, event, kind and provisional for a
 * peer event.
 */
export function channelMeta(event: HubEvent): Record<string, string> {
  if (event.type === 'peer') {
    return {
      peer: event.name,
      event: event.event,
      kind: event.kind,
      provisional: String(event.provisional),
    };
  }
  const m = event.message;
  return {
    conversation_id: m.conversation_id,
    message_id: m.id,
    from: m.from,
    expectation: m.expectation,
    final: String(m.final),
  };
}

/**
 * emitChannel turns a hub event into a notifications/claude/channel
 * notification on the MCP server and, for a message, acks its delivery as
 * notified via channel (ack failures are ignored). While the identity is still
 * provisional, a message gets IDENTIFY_FIRST appended. Returns false without
 * emitting for events that are not surfaced (peer left), and for every event
 * when channel is false (Claude Code would drop the notification): a message
 * then stays queued at the hub so the hooks surface it.
 */
export async function emitChannel(
  sink: ChannelSink,
  client: HubClient,
  identity: Identity,
  event: HubEvent,
  channel: boolean | undefined = true,
): Promise<boolean> {
  if (channel === false) return false;
  const rendered = renderChannelContent(event);
  if (rendered === undefined) return false;
  const content =
    event.type === 'message' && identity.provisional
      ? `${rendered}\n\n${IDENTIFY_FIRST}`
      : rendered;
  await sink.notification({
    method: CHANNEL_METHOD,
    params: { content, meta: channelMeta(event) },
  });
  if (event.type === 'message') {
    await client
      .ackDelivery(event.message.id, identity.agentId, identity.token, 'notified', 'channel')
      .catch(() => undefined);
  }
  return true;
}
