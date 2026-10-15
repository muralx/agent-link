import type { DatabaseSync } from 'node:sqlite';
import { newId, type Conversation } from '@agent-link/protocol';
import { now } from './db.ts';

/**
 * CreateConversation is the input of ConversationStore.create; participantIds
 * should include the creator.
 */
export interface CreateConversation {
  workspace: string;
  createdBy: string;
  subject: string | null;
  participantIds: string[];
}

/** ParticipantRef pairs an agent id with its name. */
export interface ParticipantRef {
  id: string;
  name: string;
}

/**
 * ConversationStore owns the conversation and participant tables: creating
 * threads, growing their participant set and answering membership questions.
 * Messages live in MessageStore.
 */
export class ConversationStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * create inserts a conversation and its initial participants and returns the
   * header.
   */
  create(input: CreateConversation): Conversation {
    const id = newId('cv');
    const ts = now();
    this.#db
      .prepare(
        'INSERT INTO conversation (id, workspace, subject, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.workspace, input.subject, input.createdBy, ts);
    this.addParticipants(id, input.participantIds);
    return {
      id,
      workspace: input.workspace,
      subject: input.subject,
      created_by: input.createdBy,
      created_at: ts,
    };
  }

  /** get returns the conversation header or undefined. */
  get(id: string): Conversation | undefined {
    return this.#db
      .prepare(
        'SELECT id, workspace, subject, created_by, created_at FROM conversation WHERE id = ?',
      )
      .get(id) as Conversation | undefined;
  }

  /**
   * addParticipants adds agents to a conversation; agents already present are
   * ignored.
   */
  addParticipants(conversationId: string, agentIds: string[]): void {
    const insert = this.#db.prepare(
      'INSERT OR IGNORE INTO participant (conversation_id, agent_id, joined_at) VALUES (?, ?, ?)',
    );
    const ts = now();
    for (const agentId of agentIds) insert.run(conversationId, agentId, ts);
  }

  /**
   * participantIds returns the agent ids in the conversation in no particular
   * order.
   */
  participantIds(conversationId: string): string[] {
    const rows = this.#db
      .prepare('SELECT agent_id FROM participant WHERE conversation_id = ?')
      .all(conversationId) as unknown as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }

  /**
   * participants returns the id and current name of each participant, ordered
   * by name.
   */
  participants(conversationId: string): ParticipantRef[] {
    return this.#db
      .prepare(
        `SELECT a.id, a.name FROM participant p JOIN agent a ON a.id = p.agent_id
         WHERE p.conversation_id = ? ORDER BY a.name`,
      )
      .all(conversationId) as unknown as ParticipantRef[];
  }

  /** isParticipant reports whether the agent is in the conversation. */
  isParticipant(conversationId: string, agentId: string): boolean {
    return (
      this.#db
        .prepare('SELECT 1 FROM participant WHERE conversation_id = ? AND agent_id = ?')
        .get(conversationId, agentId) !== undefined
    );
  }
}
