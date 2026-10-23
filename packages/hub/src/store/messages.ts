import type { DatabaseSync } from 'node:sqlite';
import {
  newId,
  type AgentKind,
  type Conversation,
  type ConversationKind,
  type ConversationSummary,
  type DeliveryState,
  type DeliveryVia,
  type Expectation,
  type Message,
  type OpenExpectation,
  type Recipients,
} from '@agent-link/protocol';
import type { AgentStore } from './agents.ts';
import type { ConversationStore } from './conversations.ts';
import { now } from './db.ts';
import { HubError } from './errors.ts';

/**
 * SendParams is the store-level input of send: sender id, recipients by name or
 * '*', body, expectation and the optional thread, in_reply_to override, subject,
 * final flag and group (a new conversation with several recipients becomes a
 * group instead of an announcement).
 */
export interface SendParams {
  fromId: string;
  to?: Recipients | undefined;
  body: string;
  expectation: Expectation;
  subject?: string | undefined;
  conversationId?: string | undefined;
  inReplyTo?: string | undefined;
  final?: boolean | undefined;
  /**
   * group, when the send starts a conversation with several recipients, makes
   * it a group instead of an announcement; ignored otherwise.
   */
  group?: boolean | undefined;
}

/**
 * SendResult extends the protocol's SendResponse with the stored Message, the
 * recipient ids to publish to, and the subject, participant names, starter name
 * and sender kind for the event payload.
 */
export interface SendResult {
  message_id: string;
  conversation_id: string;
  /**
   * kind is the conversation's kind after this send (a direct conversation may
   * just have become a group).
   */
  kind: ConversationKind;
  /** starter is the name of the agent that started the conversation. */
  starter: string;
  /** fromKind is the sender's kind (agent or human). */
  fromKind: AgentKind;
  delivered_to: string[];
  offline: string[];
  message: Message;
  recipientIds: string[];
  subject: string | null;
  participants: string[];
}

/** Delivery is one recipient's delivery row. */
export interface Delivery {
  state: DeliveryState;
  via: DeliveryVia | null;
  notified_at: string | null;
  read_at: string | null;
  nag_count: number;
}

/**
 * QueuedMessage is a message with the context an SSE message event carries:
 * subject, participant names, the conversation's kind, the name of the agent
 * that started it (who an announcement's replies go to) and the sender's kind.
 */
export interface QueuedMessage {
  message: Message;
  subject: string | null;
  participants: string[];
  /** kind is the kind of the message's conversation. */
  kind: ConversationKind;
  /**
   * starter is the name of the agent that started the conversation, empty when
   * it no longer exists.
   */
  starter: string;
  /** fromKind is the sender's kind (agent or human). */
  fromKind: AgentKind;
}

/**
 * Thread is the result of MessageStore.thread: header, participant names and
 * messages.
 */
export interface Thread {
  conversation: Conversation;
  participants: string[];
  messages: Message[];
}

/**
 * UnreadFilter narrows unreadFor to a conversation or to messages after a given
 * message.
 */
export interface UnreadFilter {
  conversationId?: string | undefined;
  afterMessageId?: string | undefined;
}

/**
 * MessageRow is the raw row shape produced by MESSAGE_SELECT, the sender's kind
 * included; exported for AuditStore, which runs its own message queries.
 */
export interface MessageRow {
  id: string;
  conversation_id: string;
  from_name: string;
  to_names: string;
  body: string;
  expectation: Expectation;
  final: number;
  in_reply_to: string | null;
  created_at: string;
  /** from_kind is the sender's kind from the agent table. */
  from_kind: AgentKind;
}

/**
 * MESSAGE_SELECT is the shared SELECT ... FROM message JOIN agent prefix that
 * yields MessageRow columns, the sender's name and kind included; exported for
 * AuditStore.
 */
export const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id, a.name AS from_name, m.to_names, m.body, m.expectation,
         m.final, m.in_reply_to, m.created_at, a.kind AS from_kind
  FROM message m JOIN agent a ON a.id = m.from_agent`;

/**
 * VISIBLE is the SQL condition, over message m, that keeps the messages a
 * participant sent or received; it takes the agent id twice.
 */
const VISIBLE = `(m.from_agent = ? OR EXISTS (SELECT 1 FROM delivery v WHERE v.message_id = m.id AND v.to_agent = ?))`;

/**
 * toMessage maps a MessageRow to the protocol Message, parsing to_names and the
 * final flag; exported for AuditStore.
 */
export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    from: row.from_name,
    to: JSON.parse(row.to_names) as string[],
    body: row.body,
    expectation: row.expectation,
    final: row.final === 1,
    in_reply_to: row.in_reply_to,
    created_at: row.created_at,
  };
}

/**
 * MessageStore owns the message and delivery tables and implements the
 * conversation rules of the spec: sending (new thread or reply, name
 * resolution, offline participants), system notices that bypass those rules
 * (post), per-recipient delivery state (queued, notified, read), what hooks show,
 * open expectations and the unread queries behind await. All multi-row writes
 * in send and post run in one SQLite transaction.
 */
export class MessageStore {
  readonly #db: DatabaseSync;
  readonly #agents: AgentStore;
  readonly #conversations: ConversationStore;

  /**
   * Builds a MessageStore over an open database and the agent and conversation
   * stores it resolves names and threads through.
   *
   * Only keeps the references: nothing is read, written or prepared until the
   * first call, and the schema must already exist in db. All three must share
   * the same DatabaseSync, since send runs its multi-row writes in one
   * transaction on it.
   */
  constructor(db: DatabaseSync, agents: AgentStore, conversations: ConversationStore) {
    this.#db = db;
    this.#agents = agents;
    this.#conversations = conversations;
  }

  /**
   * send writes one message. Without conversationId it starts a thread and
   * every name in to must be an online peer of the sender's workspace ('*'
   * means all of them), else peer_not_found and nothing is written. With
   * conversationId the sender must be a participant (not_participant), names in
   * to are added as participants (online required, existing ones ignored),
   * every other participant receives the message whether online or not,
   * in_reply_to defaults to the latest message from someone else, and the
   * sender's earlier deliveries in the thread become read via reply. Returns
   * the stored message plus delivery and event context.
   */
  send(params: SendParams): SendResult {
    this.#db.exec('BEGIN');
    try {
      const result = this.#sendInTransaction(params);
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * post writes a system message outside the rules of send: it starts a new
   * announcement in workspace with the given subject between fromId and
   * recipientIds, stores body with expectation none and queues one delivery per
   * recipient, online or not. The guard uses it for its notices, whose sender
   * is the offline system agent and whose recipients may be away. Returns the
   * stored message with its event context, or undefined when there is nobody to
   * tell.
   */
  post(params: {
    workspace: string;
    fromId: string;
    recipientIds: string[];
    subject: string;
    body: string;
  }): QueuedMessage | undefined {
    if (params.recipientIds.length === 0) return undefined;
    this.#db.exec('BEGIN');
    try {
      const conversation = this.#conversations.create({
        workspace: params.workspace,
        createdBy: params.fromId,
        subject: params.subject,
        kind: 'announcement',
        participantIds: [params.fromId, ...params.recipientIds],
      });
      const names = this.#conversations
        .participants(conversation.id)
        .filter((p) => p.id !== params.fromId)
        .map((p) => p.name);
      const id = newId('msg');
      this.#db
        .prepare(
          `INSERT INTO message (id, conversation_id, from_agent, to_names, body, expectation, final, in_reply_to, created_at)
           VALUES (?, ?, ?, ?, ?, 'none', 0, NULL, ?)`,
        )
        .run(id, conversation.id, params.fromId, JSON.stringify(names), params.body, now());
      const insertDelivery = this.#db.prepare(
        "INSERT INTO delivery (message_id, to_agent, state) VALUES (?, ?, 'queued')",
      );
      for (const recipient of params.recipientIds) insertDelivery.run(id, recipient);
      this.#db.exec('COMMIT');
      const row = this.#db
        .prepare(`${MESSAGE_SELECT} WHERE m.id = ?`)
        .get(id) as unknown as MessageRow;
      return this.withContext(toMessage(row), row.from_kind);
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * inbox returns the agent's messages in creation order, at most limit, and
   * marks the returned ones read via inbox. With unreadOnly it returns only
   * the messages not shown to the agent yet (still queued): what a channel
   * notification or a hook already put in its context is left out, so nothing
   * is read twice.
   */
  inbox(agentId: string, options: { unreadOnly: boolean; limit: number }): Message[] {
    const filter = options.unreadOnly ? "AND d.state = 'queued'" : '';
    const rows = this.#db
      .prepare(
        `${MESSAGE_SELECT} JOIN delivery d ON d.message_id = m.id
         WHERE d.to_agent = ? ${filter} ORDER BY m.rowid LIMIT ?`,
      )
      .all(agentId, options.limit) as unknown as MessageRow[];
    const messages = rows.map(toMessage);
    this.markRead(
      agentId,
      messages.map((m) => m.id),
      'inbox',
    );
    return messages;
  }

  /**
   * markRead moves the agent's deliveries for the given messages to read with
   * the given via; deliveries already read are left untouched.
   */
  markRead(agentId: string, messageIds: string[], via: DeliveryVia): void {
    if (messageIds.length === 0) return;
    const update = this.#db.prepare(
      `UPDATE delivery SET state = 'read', via = ?, read_at = ?
       WHERE to_agent = ? AND message_id = ? AND state != 'read'`,
    );
    const ts = now();
    for (const id of messageIds) update.run(via, ts, agentId, id);
  }

  /**
   * pendingForHook returns the messages a hook should show in full at nowIso:
   * the agent's deliveries not shown yet (still queued), oldest first. Each
   * returned delivery becomes read via hook at nowIso, since the hook puts the
   * whole message in the agent's context; nothing is shown twice. A question
   * stays open until the agent posts in its conversation (openReplies), which
   * is what the Stop hook checks.
   */
  pendingForHook(agentId: string, nowIso: string = now()): Message[] {
    const rows = this.#db
      .prepare(
        `${MESSAGE_SELECT} JOIN delivery d ON d.message_id = m.id
         WHERE d.to_agent = ? AND d.state = 'queued' ORDER BY m.rowid`,
      )
      .all(agentId) as unknown as MessageRow[];
    const update = this.#db.prepare(
      `UPDATE delivery SET state = 'read', via = 'hook', notified_at = ?, read_at = ?
       WHERE to_agent = ? AND message_id = ?`,
    );
    for (const row of rows) update.run(nowIso, nowIso, agentId, row.id);
    return rows.map(toMessage);
  }

  /**
   * openReplies lists reply-expecting messages addressed to the agent that it
   * has not answered, where answering means posting anything in that
   * conversation after the message.
   */
  openReplies(agentId: string): OpenExpectation[] {
    return this.#open(agentId, 'reply', 'r.rowid > m.rowid');
  }

  /**
   * openUpdates lists updates-expecting messages addressed to the agent not yet
   * closed by a final message from it in that conversation.
   */
  openUpdates(agentId: string): OpenExpectation[] {
    return this.#open(agentId, 'updates', 'r.rowid > m.rowid AND r.final = 1');
  }

  /** openForMe merges openReplies and openUpdates in creation order. */
  openForMe(agentId: string): OpenExpectation[] {
    return [...this.openReplies(agentId), ...this.openUpdates(agentId)].sort((x, y) =>
      x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0,
    );
  }

  /**
   * unreadFor returns the agent's unread messages, optionally only those in one
   * conversation or only those created after a given message in that message's
   * conversation; it is the query the await long poll evaluates and does not
   * change delivery state.
   */
  unreadFor(agentId: string, filter: UnreadFilter): Message[] {
    const clauses: string[] = [];
    const args: string[] = [agentId];
    if (filter.conversationId !== undefined) {
      clauses.push('AND m.conversation_id = ?');
      args.push(filter.conversationId);
    }
    if (filter.afterMessageId !== undefined) {
      clauses.push(
        `AND m.conversation_id = (SELECT conversation_id FROM message WHERE id = ?)
         AND m.rowid > (SELECT rowid FROM message WHERE id = ?)`,
      );
      args.push(filter.afterMessageId, filter.afterMessageId);
    }
    const rows = this.#db
      .prepare(
        `${MESSAGE_SELECT} JOIN delivery d ON d.message_id = m.id
         WHERE d.to_agent = ? AND d.state != 'read' ${clauses.join(' ')} ORDER BY m.rowid`,
      )
      .all(...args) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * listForAgent summarises every conversation the agent participates in
   * (kind, participants, last activity, unread count of messages not shown to
   * it yet, expectations open for it),
   * newest first; openOnly keeps only those with something open.
   */
  listForAgent(agentId: string, openOnly: boolean): ConversationSummary[] {
    const convs = this.#db
      .prepare(
        `SELECT c.id, c.subject, c.kind FROM conversation c JOIN participant p ON p.conversation_id = c.id
         WHERE p.agent_id = ?`,
      )
      .all(agentId) as unknown as { id: string; subject: string | null; kind: ConversationKind }[];
    const open = this.openForMe(agentId);
    const summaries = convs.map((c): ConversationSummary => {
      const last = this.#db
        .prepare('SELECT MAX(created_at) AS t FROM message WHERE conversation_id = ?')
        .get(c.id) as { t: string | null };
      const unread = this.#db
        .prepare(
          `SELECT COUNT(*) AS n FROM delivery d JOIN message m ON m.id = d.message_id
           WHERE d.to_agent = ? AND d.state = 'queued' AND m.conversation_id = ?`,
        )
        .get(agentId, c.id) as { n: number };
      return {
        id: c.id,
        subject: c.subject,
        kind: c.kind,
        participants: this.#conversations.participants(c.id).map((p) => p.name),
        last_message_at: last.t,
        unread: unread.n,
        open_for_me: open.filter((o) => o.conversation_id === c.id),
      };
    });
    const filtered = openOnly ? summaries.filter((s) => s.open_for_me.length > 0) : summaries;
    return filtered.sort((x, y) =>
      (x.last_message_at ?? '') < (y.last_message_at ?? '') ? 1 : -1,
    );
  }

  /**
   * thread returns the conversation's messages the agent sent or received, in
   * order, or only those after the since message id (not_found if it is not in
   * the thread), and marks the returned ones read via conversation; not_found
   * for an unknown conversation and not_participant for an outsider. In an
   * announcement a recipient therefore sees the starter's messages and its own,
   * never the other recipients' replies.
   */
  thread(agentId: string, conversationId: string, since?: string): Thread {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation)
      throw new HubError('not_found', `conversation ${conversationId} does not exist`);
    if (!this.#conversations.isParticipant(conversationId, agentId)) {
      throw new HubError('not_participant', 'you are not a participant of this conversation');
    }
    let rows: MessageRow[];
    if (since !== undefined) {
      const anchor = this.#db
        .prepare('SELECT rowid AS r FROM message WHERE id = ? AND conversation_id = ?')
        .get(since, conversationId) as { r: number } | undefined;
      if (!anchor) throw new HubError('not_found', `message ${since} is not in this conversation`);
      rows = this.#db
        .prepare(
          `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.rowid > ? AND ${VISIBLE} ORDER BY m.rowid`,
        )
        .all(conversationId, anchor.r, agentId, agentId) as unknown as MessageRow[];
    } else {
      rows = this.#db
        .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND ${VISIBLE} ORDER BY m.rowid`)
        .all(conversationId, agentId, agentId) as unknown as MessageRow[];
    }
    const messages = rows.map(toMessage);
    this.markRead(
      agentId,
      messages.map((m) => m.id),
      'conversation',
    );
    return {
      conversation,
      participants: this.#conversations.participants(conversationId).map((p) => p.name),
      messages,
    };
  }

  /**
   * ack applies a delivery transition requested by the edge: notified only from
   * queued (recording via and notified_at), read from any state; a request to
   * go back to queued, or from read to notified, is ignored.
   */
  ack(messageId: string, agentId: string, state: DeliveryState, via: DeliveryVia): void {
    if (state === 'read') {
      this.markRead(agentId, [messageId], via);
    } else if (state === 'notified') {
      this.#db
        .prepare(
          `UPDATE delivery SET state = 'notified', via = ?, notified_at = ?
           WHERE message_id = ? AND to_agent = ? AND state = 'queued'`,
        )
        .run(via, now(), messageId, agentId);
    }
  }

  /**
   * deliveryState returns the delivery row for one message and recipient, or
   * undefined.
   */
  deliveryState(messageId: string, agentId: string): Delivery | undefined {
    return this.#db
      .prepare(
        'SELECT state, via, notified_at, read_at, nag_count FROM delivery WHERE message_id = ? AND to_agent = ?',
      )
      .get(messageId, agentId) as Delivery | undefined;
  }

  /**
   * queuedFor returns the agent's still-queued messages, oldest first, each
   * with the event context withContext adds (subject, participant names, kind,
   * starter, sender kind); used to replay on stream connect.
   */
  queuedFor(agentId: string): QueuedMessage[] {
    const rows = this.#db
      .prepare(
        `${MESSAGE_SELECT} JOIN delivery d ON d.message_id = m.id
         WHERE d.to_agent = ? AND d.state = 'queued' ORDER BY m.rowid`,
      )
      .all(agentId) as unknown as MessageRow[];
    return rows.map((row) => this.withContext(toMessage(row), row.from_kind));
  }

  /**
   * withContext attaches the conversation subject, participant names, kind and
   * starter name, and the given sender kind, to a message: the payload an SSE
   * message event is built from. A conversation that no longer exists gives a
   * null subject, kind group and an empty starter.
   */
  withContext(message: Message, fromKind: AgentKind): QueuedMessage {
    const conversation = this.#conversations.get(message.conversation_id);
    return {
      message,
      subject: conversation?.subject ?? null,
      participants: this.#conversations.participants(message.conversation_id).map((p) => p.name),
      kind: conversation?.kind ?? 'group',
      starter: conversation ? (this.#agents.byId(conversation.created_by)?.name ?? '') : '',
      fromKind,
    };
  }

  /**
   * #open lists the messages delivered to agentId that carry the given
   * expectation and that the agent has not yet closed, oldest first, as
   * OpenExpectation records (message_id, conversation_id, sender name as from,
   * expectation, created_at).
   *
   * closedBy is a SQL fragment, not data: it is spliced into a NOT EXISTS
   * subquery over the messages r the agent itself posted in the same
   * conversation as the open message m, so it may only refer to r and m columns
   * and must come from code (openReplies passes a later rowid, openUpdates a
   * later rowid with final = 1). A message counts as open while no such closing
   * message exists. Read-only: delivery state is not touched.
   */
  #open(agentId: string, expectation: Expectation, closedBy: string): OpenExpectation[] {
    const rows = this.#db
      .prepare(
        `SELECT m.id AS message_id, m.conversation_id, a.name AS "from", m.expectation, m.created_at
         FROM delivery d JOIN message m ON m.id = d.message_id JOIN agent a ON a.id = m.from_agent
         WHERE d.to_agent = ? AND m.expectation = ?
           AND NOT EXISTS (SELECT 1 FROM message r
                           WHERE r.conversation_id = m.conversation_id AND r.from_agent = ? AND ${closedBy})
         ORDER BY m.rowid`,
      )
      .all(agentId, expectation, agentId) as unknown as OpenExpectation[];
    return rows;
  }

  /**
   * #resolveNames maps recipient names to agent ids within the sender's
   * workspace, in the order given, or throws peer_not_found when any name has
   * no online agent.
   *
   * Every name is checked before failing, so the error carries all unknown
   * names at once in extra.missing, the names of the sender's online peers in
   * extra.online, and the hint to call peers. A name that resolves is never a
   * partial result: either all names resolve or nothing is returned.
   */
  #resolveNames(workspace: string, fromId: string, names: string[]): string[] {
    const ids: string[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const agent = this.#agents.byName(workspace, name);
      if (agent) ids.push(agent.id);
      else missing.push(name);
    }
    if (missing.length > 0) {
      throw new HubError('peer_not_found', `no online peer named ${missing.join(', ')}`, {
        hint: 'call peers to see who is online',
        extra: { missing, online: this.#agents.peers(workspace, fromId).map((p) => p.name) },
      });
    }
    return ids;
  }

  /**
   * #sendInTransaction does the whole work of send inside the transaction send
   * opens: it validates the sender, finds or creates the conversation, inserts
   * the message row and one queued delivery per recipient, and returns the
   * SendResult.
   *
   * The sender must be an online agent (not_registered otherwise). With a
   * conversationId, the conversation must exist in the sender's workspace
   * (not_found) and the sender must be a participant (not_participant); any to
   * names, or "*" for every online peer, are added as participants (a direct
   * conversation that grows past two becomes a group); the recipients are the
   * starter alone when someone else posts into an announcement, otherwise every
   * other participant; and the sender's unread deliveries in that conversation
   * are marked read, since posting counts as having read the thread. Without a
   * conversationId, to is required (invalid_message), recipients are the
   * resolved names or every online peer, an empty set is peer_not_found with
   * extra.online set to [], and a new conversation with the optional subject is
   * created around sender and recipients: direct for one named recipient,
   * otherwise an announcement, or a group when params.group. in_reply_to
   * defaults to the latest message from someone else in an existing
   * conversation, and to null for a new one. Deliveries are inserted for
   * offline participants too; the result splits recipient names into
   * delivered_to (online) and offline, and also carries the recipient ids,
   * kind, starter, sender kind, subject and participant names the caller needs
   * to publish SSE events.
   */
  #sendInTransaction(params: SendParams): SendResult {
    const from = this.#agents.byId(params.fromId);
    if (!from || from.status !== 'online') {
      throw new HubError('not_registered', 'sender is not an online agent');
    }
    let conversation: Conversation;
    let recipientIds: string[];
    if (params.conversationId !== undefined) {
      const existing = this.#conversations.get(params.conversationId);
      if (!existing || existing.workspace !== from.workspace) {
        throw new HubError('not_found', `conversation ${params.conversationId} does not exist`);
      }
      if (!this.#conversations.isParticipant(existing.id, from.id)) {
        throw new HubError('not_participant', 'you are not a participant of this conversation');
      }
      conversation = existing;
      if (params.to !== undefined) {
        const added =
          params.to === '*'
            ? this.#agents.onlineIds(from.workspace, from.id)
            : this.#resolveNames(from.workspace, from.id, params.to);
        this.#conversations.addParticipants(existing.id, added);
        if (
          existing.kind === 'direct' &&
          this.#conversations.participantIds(existing.id).length > 2
        ) {
          this.#conversations.setKind(existing.id, 'group');
          existing.kind = 'group';
        }
      }
      recipientIds =
        existing.kind === 'announcement' && existing.created_by !== from.id
          ? [existing.created_by]
          : this.#conversations.participantIds(existing.id).filter((id) => id !== from.id);
      this.#markConversationRead(from.id, existing.id);
    } else {
      if (params.to === undefined) {
        throw new HubError('invalid_message', 'to is required when starting a conversation');
      }
      recipientIds =
        params.to === '*'
          ? this.#agents.onlineIds(from.workspace, from.id)
          : this.#resolveNames(from.workspace, from.id, params.to);
      if (recipientIds.length === 0) {
        throw new HubError('peer_not_found', 'no peers are online in this workspace', {
          extra: { online: [] },
        });
      }
      conversation = this.#conversations.create({
        workspace: from.workspace,
        createdBy: from.id,
        subject: params.subject ?? null,
        kind:
          recipientIds.length === 1 && params.to !== '*'
            ? 'direct'
            : params.group
              ? 'group'
              : 'announcement',
        participantIds: [from.id, ...recipientIds],
      });
    }

    const inReplyTo =
      params.inReplyTo ??
      (params.conversationId !== undefined
        ? this.#latestFromOthers(conversation.id, from.id)
        : null);
    const recipients = recipientIds.map((id) => {
      const agent = this.#agents.byId(id);
      if (!agent) throw new Error(`participant ${id} vanished`);
      return agent;
    });
    const id = newId('msg');
    const ts = now();
    this.#db
      .prepare(
        `INSERT INTO message (id, conversation_id, from_agent, to_names, body, expectation, final, in_reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        conversation.id,
        from.id,
        JSON.stringify(recipients.map((r) => r.name)),
        params.body,
        params.expectation,
        params.final ? 1 : 0,
        inReplyTo,
        ts,
      );
    const insertDelivery = this.#db.prepare(
      "INSERT INTO delivery (message_id, to_agent, state) VALUES (?, ?, 'queued')",
    );
    for (const r of recipients) insertDelivery.run(id, r.id);

    const message: Message = {
      id,
      conversation_id: conversation.id,
      from: from.name,
      to: recipients.map((r) => r.name),
      body: params.body,
      expectation: params.expectation,
      final: params.final ?? false,
      in_reply_to: inReplyTo,
      created_at: ts,
    };
    return {
      message_id: id,
      conversation_id: conversation.id,
      kind: conversation.kind,
      starter: this.#agents.byId(conversation.created_by)?.name ?? '',
      fromKind: from.kind,
      delivered_to: recipients.filter((r) => r.status === 'online').map((r) => r.name),
      offline: recipients.filter((r) => r.status !== 'online').map((r) => r.name),
      message,
      recipientIds,
      subject: conversation.subject,
      participants: this.#conversations.participants(conversation.id).map((p) => p.name),
    };
  }

  /**
   * #latestFromOthers returns the id of the most recent message in the
   * conversation not sent by agentId, or null when every message so far is the
   * agent's own or the conversation is empty.
   *
   * Recency is insertion order (rowid), not created_at. send uses it as the
   * implicit in_reply_to of a message posted into an existing conversation when
   * the caller did not name one, so a reply threads under the last thing
   * someone else said.
   */
  #latestFromOthers(conversationId: string, agentId: string): string | null {
    const row = this.#db
      .prepare(
        `SELECT id FROM message WHERE conversation_id = ? AND from_agent != ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(conversationId, agentId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * #markConversationRead moves every unread delivery addressed to agentId for
   * messages in the conversation to state read, with via set to reply and
   * read_at set to now.
   *
   * Deliveries already read keep their original via and read_at. send calls it
   * when an agent posts into an existing conversation, on the premise that
   * answering a thread means having read it, so those messages stop appearing
   * in inbox, unread queries and hook nags. It runs inside the send transaction
   * and does not touch deliveries to other agents.
   */
  #markConversationRead(agentId: string, conversationId: string): void {
    this.#db
      .prepare(
        `UPDATE delivery SET state = 'read', via = 'reply', read_at = ?
         WHERE to_agent = ? AND state != 'read'
           AND message_id IN (SELECT id FROM message WHERE conversation_id = ?)`,
      )
      .run(now(), agentId, conversationId);
  }
}
