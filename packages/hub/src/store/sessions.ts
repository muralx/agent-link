import type { DatabaseSync } from 'node:sqlite';
import type { Session } from '@agent-link/protocol';
import { now } from './db.ts';

/**
 * SessionUpsert is the input of SessionStore.upsert: the session id plus
 * optional cwd, workspace_hint and window; omitted fields leave stored values
 * untouched.
 */
export interface SessionUpsert {
  session_id: string;
  cwd?: string | undefined;
  workspace_hint?: string | undefined;
  /**
   * window is the Claude Code window id the hook observed, kept so a session
   * can be traced to its window.
   */
  window?: string | undefined;
}

/**
 * SessionStore owns the session table, which lets the hooks (which hold no
 * agent token) find an agent by Claude Code session id.
 */
export class SessionStore {
  readonly #db: DatabaseSync;

  /**
   * Builds a SessionStore over an open database whose session table already
   * exists.
   *
   * Only keeps the reference: no query runs and no statement is prepared until
   * the first call. Pass the hub's single DatabaseSync so session links land in
   * the same database as the agents they point to.
   */
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * upsert records a session, keeping any previously stored cwd, workspace_hint
   * or window that the new input omits, and returns the stored row.
   */
  upsert(input: SessionUpsert): Session {
    this.#db
      .prepare(
        `INSERT INTO session (session_id, cwd, workspace_hint, window, agent_id, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           cwd = COALESCE(excluded.cwd, session.cwd),
           workspace_hint = COALESCE(excluded.workspace_hint, session.workspace_hint),
           window = COALESCE(excluded.window, session.window)`,
      )
      .run(
        input.session_id,
        input.cwd ?? null,
        input.workspace_hint ?? null,
        input.window ?? null,
        now(),
      );
    return this.#mustGet(input.session_id);
  }

  /** linkAgent binds a session to the agent it registered. */
  linkAgent(sessionId: string, agentId: string): void {
    this.#db
      .prepare('UPDATE session SET agent_id = ? WHERE session_id = ?')
      .run(agentId, sessionId);
  }

  /**
   * get returns the stored session (session_id, cwd, workspace_hint, window,
   * agent_id) or undefined.
   */
  get(sessionId: string): Session | undefined {
    return this.#db
      .prepare(
        'SELECT session_id, cwd, workspace_hint, window, agent_id FROM session WHERE session_id = ?',
      )
      .get(sessionId) as Session | undefined;
  }

  /**
   * #mustGet returns the stored session or throws a plain Error, since a
   * session the caller has just written cannot be absent.
   *
   * The thrown Error is not a HubError and so surfaces as an unexpected
   * failure; upsert uses it to return the row it just inserted or updated.
   */
  #mustGet(sessionId: string): Session {
    const s = this.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} vanished`);
    return s;
  }
}
