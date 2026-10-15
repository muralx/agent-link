import type { DatabaseSync } from 'node:sqlite';
import type { AuditConversation, Message } from '@agent-link/protocol';
import type { ConversationStore } from './conversations.ts';
import { HubError } from './errors.ts';
import { MESSAGE_SELECT, toMessage, type MessageRow, type Thread } from './messages.ts';

/** FeedPage is one page of the workspace message feed. */
export interface FeedPage {
  /** messages are the page's messages in creation order. */
  messages: Message[];
  /**
   * cursor is the id of the last message the reader has now seen: the last one
   * of this page, else the cursor it asked with, else the newest message of the
   * workspace, else null when the workspace has none.
   */
  cursor: string | null;
}

/**
 * AuditStore answers the read-only questions of the workspace audit view:
 * every conversation of a workspace, one thread, and the message feed. Unlike
 * MessageStore it does not require the reader to be a participant and never
 * changes delivery state, so observing leaves no trace on what recipients see
 * as read. Access control is the route's job.
 */
export class AuditStore {
  /** #db is the hub's open database. */
  readonly #db: DatabaseSync;
  /** #conversations resolves conversation headers and participant names. */
  readonly #conversations: ConversationStore;

  /**
   * Builds an AuditStore over an open database and the conversation store it
   * resolves headers and participants through.
   */
  constructor(db: DatabaseSync, conversations: ConversationStore) {
    this.#db = db;
    this.#conversations = conversations;
  }

  /**
   * conversations lists every conversation of the workspace with participant
   * names, message count and last activity, most recently active first.
   */
  conversations(workspace: string): AuditConversation[] {
    const rows = this.#db
      .prepare(
        `SELECT c.id, c.subject, c.created_at, COUNT(m.id) AS messages,
                MAX(m.created_at) AS last_message_at
         FROM conversation c LEFT JOIN message m ON m.conversation_id = c.id
         WHERE c.workspace = ? GROUP BY c.id
         ORDER BY COALESCE(MAX(m.rowid), 0) DESC`,
      )
      .all(workspace) as unknown as Omit<AuditConversation, 'participants'>[];
    return rows.map((row) => ({
      ...row,
      participants: this.#conversations.participants(row.id).map((p) => p.name),
    }));
  }

  /**
   * thread returns a conversation of the workspace with all its messages in
   * order; not_found when it does not exist or belongs to another workspace.
   */
  thread(workspace: string, conversationId: string): Thread {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation || conversation.workspace !== workspace) {
      throw new HubError('not_found', `conversation ${conversationId} does not exist`);
    }
    const rows = this.#db
      .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? ORDER BY m.rowid`)
      .all(conversationId) as unknown as MessageRow[];
    return {
      conversation,
      participants: this.#conversations.participants(conversationId).map((p) => p.name),
      messages: rows.map(toMessage),
    };
  }

  /**
   * feed returns the workspace's messages sent after the since message, oldest
   * first, at most limit; without since it returns no messages and the cursor
   * of the newest one, so a reader starts from now. not_found when since is not
   * a message of this workspace.
   */
  feed(workspace: string, since: string | undefined, limit: number): FeedPage {
    if (since === undefined) return { messages: [], cursor: this.#newest(workspace) };
    const anchor = this.#db
      .prepare(
        `SELECT m.rowid AS r FROM message m JOIN conversation c ON c.id = m.conversation_id
         WHERE m.id = ? AND c.workspace = ?`,
      )
      .get(since, workspace) as { r: number } | undefined;
    if (!anchor) throw new HubError('not_found', `message ${since} is not in this workspace`);
    const rows = this.#db
      .prepare(
        `${MESSAGE_SELECT} JOIN conversation c ON c.id = m.conversation_id
         WHERE c.workspace = ? AND m.rowid > ? ORDER BY m.rowid LIMIT ?`,
      )
      .all(workspace, anchor.r, limit) as unknown as MessageRow[];
    const messages = rows.map(toMessage);
    return { messages, cursor: messages.at(-1)?.id ?? since };
  }

  /** #newest returns the id of the workspace's newest message, or null. */
  #newest(workspace: string): string | null {
    const row = this.#db
      .prepare(
        `SELECT m.id FROM message m JOIN conversation c ON c.id = m.conversation_id
         WHERE c.workspace = ? ORDER BY m.rowid DESC LIMIT 1`,
      )
      .get(workspace) as { id: string } | undefined;
    return row?.id ?? null;
  }
}
