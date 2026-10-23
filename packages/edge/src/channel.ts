import type { HubEvent, MessageEvent } from '@agent-link/protocol';
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
 * audience says, for the recipient me, who else got a message and where a
 * reply would go: nothing in a direct conversation; in an announcement, the
 * starter and the number of recipients with "your reply goes to <starter>
 * only", or "reply to your announcement" when me is the starter; in a group,
 * the other members and that replies reach everyone.
 */
export function audience(event: MessageEvent, me: string): string | undefined {
  const others = event.participants.filter((p) => p !== me);
  if (event.kind === 'announcement') {
    const starter = event.starter ?? event.message.from;
    if (starter === me) return 'reply to your announcement';
    const n = event.participants.filter((p) => p !== starter).length;
    return `announcement from ${starter} to ${n} peers; your reply goes to ${starter} only`;
  }
  if (event.kind === 'group') return `group with ${others.join(', ')}; replies reach everyone`;
  return undefined;
}

/**
 * renderChannelContent formats the channel text of a message for the
 * recipient me: an optional first line with «subject», the audience note and
 * [final], then the body. Sender, expectation and ids are not repeated: they
 * are in the channel tag's attributes. Peer events are not surfaced (undefined):
 * pushing them would wake every idle window for news nobody acts on; peers
 * lists who is online when it matters.
 */
export function renderChannelContent(event: HubEvent, me = ''): string | undefined {
  if (event.type === 'peer') return undefined;
  const parts = [
    event.subject ? `«${event.subject}»` : '',
    audience(event, me) ?? '',
    event.message.final ? '[final]' : '',
  ].filter((p) => p !== '');
  return parts.length > 0 ? `${parts.join(' — ')}\n\n${event.message.body}` : event.message.body;
}

/**
 * channelMeta builds the channel meta attributes (all string values, identifier
 * keys as the channel contract requires): conversation_id, message_id, from,
 * expectation, final and kind (direct, announcement or group) for a message;
 * peer, event, kind and provisional for a peer event.
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
    kind: event.kind,
  };
}

/**
 * emitChannel turns a hub event into a notifications/claude/channel
 * notification on the MCP server and, for a message, acks its delivery as
 * notified via channel (ack failures are ignored). While the identity is still
 * provisional, a message gets IDENTIFY_FIRST appended. Returns false without
 * emitting, leaving the message queued at the hub so a hook shows it in full
 * at the window's next prompt or tool call: for every event when channel is
 * false (Claude Code would drop the notification), for a message whose event
 * says not to wake the window (the hub sets wake on every message today), for
 * a message an
 * active await of this edge will return (awaited, so it is not shown twice),
 * and for peer events, which are not surfaced.
 */
export async function emitChannel(
  sink: ChannelSink,
  client: HubClient,
  identity: Identity,
  event: HubEvent,
  channel: boolean | undefined = true,
  awaited: (event: MessageEvent) => boolean = () => false,
): Promise<boolean> {
  if (channel === false) return false;
  if (event.type === 'message' && (!event.wake || awaited(event))) return false;
  const rendered = renderChannelContent(event, identity.name);
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
