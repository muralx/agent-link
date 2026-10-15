import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { GUARD_NAME, newId, type Agent, type AgentKind, type Peer } from '@agent-link/protocol';
import { now } from './db.ts';
import { HubError } from './errors.ts';

/**
 * RegisterProfile is what the hub needs to register an agent: the session that
 * owns it, its prose profile, the resolved workspace and its kind, plus
 * provisional (true for the edge's automatic registration before the model has
 * identified itself), window (the Claude Code window id the edge runs in, used
 * to find the agent again when the window switches sessions), agent_id (the
 * agent the edge already is, when it has one) and watcher (read access to the
 * workspace audit view).
 */
export interface RegisterProfile {
  session_id: string;
  name: string;
  description: string;
  capabilities: string;
  workspace: string;
  kind: AgentKind;
  /**
   * provisional marks an automatic registration whose name and profile are
   * placeholders; a provisional request against an existing agent only
   * reconnects it.
   */
  provisional?: boolean | undefined;
  /**
   * window identifies the Claude Code window (process) the edge belongs to; it
   * outlives session ids inside that window.
   */
  window?: string | undefined;
  /**
   * agent_id names the agent the registering edge already is (its current
   * identity, proven to the route by its token); the registration upgrades that
   * row whatever session id it carries now.
   */
  agent_id?: string | undefined;
  /**
   * watcher asks for read access to the workspace audit view; like kind it is
   * replaced by an identified registration and kept by a provisional reconnect.
   */
  watcher?: boolean | undefined;
}

/**
 * SYSTEM_SESSION_PREFIX starts the session id of a workspace's system agent
 * (the guard's sender); no edge may register with such a session id.
 */
export const SYSTEM_SESSION_PREFIX = 'system:';

/**
 * Registration is the result of AgentStore.register: the stored agent, the
 * plaintext bearer token (never stored, cannot be recovered later) and
 * previous, the agent record as it was before a reclaim, or undefined for a
 * brand-new agent.
 */
export interface Registration {
  agent: Agent;
  token: string;
  /**
   * previous is the reclaimed agent's record before this registration (name,
   * status, provisional), undefined when the agent was just created.
   */
  previous: Agent | undefined;
}

/**
 * AgentRow is the raw shape of a SELECT over the agent table's public columns;
 * provisional and watcher are SQLite integer flags (0/1), window the nullable
 * window id and quarantined_at the time of a quarantine or null.
 */
interface AgentRow {
  id: string;
  name: string;
  workspace: string;
  description: string;
  capabilities: string;
  kind: AgentKind;
  session_id: string;
  status: 'online' | 'offline';
  registered_at: string;
  last_seen: string;
  /**
   * provisional is 1 for an automatic, not yet identified registration, else 0.
   */
  provisional: number;
  /**
   * window is the Claude Code window id the agent's edge reported, or null for
   * registrations without one.
   */
  window: string | null;
  /** watcher is 1 when the agent registered as a watcher, else 0. */
  watcher: number;
  /**
   * quarantined_at is when the guard quarantined the agent, or null while it
   * may send.
   */
  quarantined_at: string | null;
}

/**
 * AGENT_COLUMNS lists the agent columns exposed through Agent, including
 * provisional, window, watcher and quarantined_at; token_hash and offline_at
 * are deliberately absent.
 */
const AGENT_COLUMNS =
  'id, name, workspace, description, capabilities, kind, session_id, status, registered_at, last_seen, provisional, window, watcher, quarantined_at';

/**
 * hashToken returns the hex SHA-256 of a bearer token; only hashes are stored.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * toAgent maps a database row to the protocol's Agent shape, turning the
 * provisional and watcher integers into booleans and quarantined_at into the
 * quarantined flag.
 */
function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    workspace: row.workspace,
    description: row.description,
    capabilities: row.capabilities,
    kind: row.kind,
    provisional: row.provisional === 1,
    watcher: row.watcher === 1,
    quarantined: row.quarantined_at !== null,
    session_id: row.session_id,
    window: row.window,
    status: row.status,
    registered_at: row.registered_at,
    last_seen: row.last_seen,
  };
}

/**
 * toPeer maps a database row to the Peer shape shown to other agents (name,
 * description, capabilities, kind, provisional, last_seen, watcher,
 * quarantined), dropping ids, workspace, status, session and window.
 */
function toPeer(row: AgentRow): Peer {
  return {
    name: row.name,
    description: row.description,
    capabilities: row.capabilities,
    kind: row.kind,
    provisional: row.provisional === 1,
    last_seen: row.last_seen,
    watcher: row.watcher === 1,
    quarantined: row.quarantined_at !== null,
  };
}

/**
 * AgentStore owns the agent table: registration with reclaim by the edge's own
 * agent id, by session id or by window id, adoption of an offline namesake by
 * an identified registration (absorbing the window's placeholder), name
 * suffixing (the guard's name is reserved), provisional reconnects that keep an
 * identity, token lookup, presence (online/offline), session relinking, peer
 * listing, the per-workspace system agent the guard sends from, and the
 * quarantine flag. One instance per hub; it is not safe to share one
 * DatabaseSync across threads.
 */
export class AgentStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * register creates an online agent, or reclaims an existing one: the agent
   * profile.agent_id names (the edge's current identity, verified by the
   * route), else the agent bound to profile.session_id, else, only for a
   * provisional request, the agent of profile.window (a restarted edge in the
   * same window after a session switch). An identified request (provisional not
   * true) that found nothing or only a provisional placeholder adopts the
   * offline, identified agent holding profile.name in the workspace, if any:
   * that row keeps its id, conversations and deliveries, and the placeholder is
   * folded into it with #absorb and deleted; previous then describes the
   * placeholder. A reclaim issues a new token, sets status online and updates
   * session and window. With provisional true it is a reconnect: name,
   * description, capabilities, kind, watcher and the provisional flag are kept,
   * so an automatic registration never overwrites an identity the model chose;
   * any other reclaim replaces the profile and clears provisional. A quarantine
   * is never cleared by registering. The name is kept when free and suffixed
   * -2, -3, ... when another online agent in the workspace holds it or it is
   * the reserved guard name; the returned agent.name is authoritative. A
   * session id starting with system: is refused with invalid_message. The
   * update and absorption run in one transaction.
   */
  register(profile: RegisterProfile): Registration {
    if (profile.session_id.startsWith(SYSTEM_SESSION_PREFIX)) {
      throw new HubError('invalid_message', 'session ids starting with system: are reserved');
    }
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const ts = now();
    let existing =
      (profile.agent_id ? this.#rowById(profile.agent_id) : undefined) ??
      this.#rowBySession(profile.session_id) ??
      (profile.provisional === true && profile.window
        ? this.#rowByWindow(profile.window)
        : undefined);
    let absorbed: AgentRow | undefined;
    if (profile.provisional !== true && (!existing || existing.provisional === 1)) {
      const named = this.#offlineByName(profile.workspace, profile.name, existing?.id);
      if (named) {
        absorbed = existing;
        existing = named;
      }
    }
    if (existing) {
      const previous = toAgent(absorbed ?? existing);
      const keep = profile.provisional === true;
      const name = this.#uniqueName(
        profile.workspace,
        keep ? existing.name : profile.name,
        existing.id,
      );
      this.#db.exec('BEGIN');
      try {
        if (absorbed) this.#absorb(absorbed.id, existing.id);
        this.#db
          .prepare(
            `UPDATE agent SET name = ?, workspace = ?, description = ?, capabilities = ?, kind = ?,
               provisional = ?, watcher = ?, session_id = ?, window = ?, token_hash = ?,
               status = 'online', offline_at = NULL, last_seen = ?
             WHERE id = ?`,
          )
          .run(
            name,
            profile.workspace,
            keep ? existing.description : profile.description,
            keep ? existing.capabilities : profile.capabilities,
            keep ? existing.kind : profile.kind,
            keep ? existing.provisional : 0,
            keep ? existing.watcher : profile.watcher === true ? 1 : 0,
            profile.session_id,
            profile.window ?? existing.window,
            tokenHash,
            ts,
            existing.id,
          );
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
      return { agent: this.#mustGet(existing.id), token, previous };
    }
    const id = newId('ag');
    const name = this.#uniqueName(profile.workspace, profile.name, id);
    this.#db
      .prepare(
        `INSERT INTO agent (id, name, workspace, description, capabilities, kind, session_id,
           window, provisional, watcher, token_hash, status, registered_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
      )
      .run(
        id,
        name,
        profile.workspace,
        profile.description,
        profile.capabilities,
        profile.kind,
        profile.session_id,
        profile.window ?? null,
        profile.provisional === true ? 1 : 0,
        profile.watcher === true ? 1 : 0,
        tokenHash,
        ts,
        ts,
      );
    return { agent: this.#mustGet(id), token, previous: undefined };
  }

  /**
   * #offlineByName returns the offline, identified (not provisional) agent that
   * holds name in the workspace, other than exceptId, or undefined: the row a
   * returning agent adopts so it keeps its conversations and mailbox. The
   * workspace's system agent is never returned, so nobody adopts the guard.
   */
  #offlineByName(workspace: string, name: string, exceptId?: string): AgentRow | undefined {
    return this.#db
      .prepare(
        `SELECT ${AGENT_COLUMNS} FROM agent
         WHERE workspace = ? AND name = ? AND status = 'offline' AND provisional = 0
           AND id != ? AND session_id NOT LIKE '${SYSTEM_SESSION_PREFIX}%'
         ORDER BY last_seen DESC LIMIT 1`,
      )
      .get(workspace, name, exceptId ?? '') as AgentRow | undefined;
  }

  /**
   * #absorb folds the placeholder agent fromId into toId: its conversation
   * memberships, deliveries, sent messages, created conversations and session
   * links move over (memberships and deliveries toId already has are dropped),
   * a quarantine on the placeholder carries over so adopting a name is no way
   * out of it, the placeholder's incidents follow, and the placeholder row is
   * deleted. Runs inside the caller's transaction.
   */
  #absorb(fromId: string, toId: string): void {
    const db = this.#db;
    db.prepare(
      `UPDATE agent SET
         quarantined_at = COALESCE(quarantined_at, (SELECT quarantined_at FROM agent WHERE id = ?)),
         quarantine_reason = COALESCE(quarantine_reason, (SELECT quarantine_reason FROM agent WHERE id = ?))
       WHERE id = ?`,
    ).run(fromId, fromId, toId);
    db.prepare('UPDATE incident SET agent_id = ? WHERE agent_id = ?').run(toId, fromId);
    db.prepare('UPDATE incident SET by_agent = ? WHERE by_agent = ?').run(toId, fromId);
    db.prepare('UPDATE OR IGNORE participant SET agent_id = ? WHERE agent_id = ?').run(
      toId,
      fromId,
    );
    db.prepare('DELETE FROM participant WHERE agent_id = ?').run(fromId);
    db.prepare('UPDATE OR IGNORE delivery SET to_agent = ? WHERE to_agent = ?').run(toId, fromId);
    db.prepare('DELETE FROM delivery WHERE to_agent = ?').run(fromId);
    db.prepare('UPDATE message SET from_agent = ? WHERE from_agent = ?').run(toId, fromId);
    db.prepare('UPDATE conversation SET created_by = ? WHERE created_by = ?').run(toId, fromId);
    db.prepare('UPDATE session SET agent_id = ? WHERE agent_id = ?').run(toId, fromId);
    db.prepare('DELETE FROM agent WHERE id = ?').run(fromId);
  }

  /** #rowById returns the agent row with that id in any status. */
  #rowById(id: string): AgentRow | undefined {
    return this.#db.prepare(`SELECT ${AGENT_COLUMNS} FROM agent WHERE id = ?`).get(id) as
      AgentRow | undefined;
  }

  /**
   * byWindow returns the agent most recently seen in a Claude Code window (the
   * edge process's window id) in any status, or undefined.
   */
  byWindow(window: string): Agent | undefined {
    const row = this.#rowByWindow(window);
    return row ? toAgent(row) : undefined;
  }

  /**
   * relinkSession binds an agent to a new Claude Code session id, used when a
   * window switches sessions (/clear, /resume) while its edge keeps running.
   */
  relinkSession(agentId: string, sessionId: string): void {
    this.#db
      .prepare('UPDATE agent SET session_id = ?, last_seen = ? WHERE id = ?')
      .run(sessionId, now(), agentId);
  }

  /**
   * #rowByWindow returns the agent row for a window id, preferring an online
   * one and then the most recently seen, or undefined.
   */
  #rowByWindow(window: string): AgentRow | undefined {
    return this.#db
      .prepare(
        `SELECT ${AGENT_COLUMNS} FROM agent WHERE window = ?
         ORDER BY status = 'online' DESC, last_seen DESC LIMIT 1`,
      )
      .get(window) as AgentRow | undefined;
  }

  /** byId returns the agent with that id in any status, or undefined. */
  byId(id: string): Agent | undefined {
    const row = this.#rowById(id);
    return row ? toAgent(row) : undefined;
  }

  /**
   * byToken resolves a bearer token to its online agent, or undefined when the
   * token is unknown or the agent is offline (an old token stops working on
   * reclaim).
   */
  byToken(token: string): Agent | undefined {
    const row = this.#db
      .prepare(`SELECT ${AGENT_COLUMNS} FROM agent WHERE token_hash = ? AND status = 'online'`)
      .get(hashToken(token)) as AgentRow | undefined;
    return row ? toAgent(row) : undefined;
  }

  /**
   * bySession returns the agent bound to a Claude Code session id in any
   * status, or undefined.
   */
  bySession(sessionId: string): Agent | undefined {
    const row = this.#rowBySession(sessionId);
    return row ? toAgent(row) : undefined;
  }

  /**
   * byName resolves a peer name within a workspace to its online agent; offline
   * agents are not addressable.
   */
  byName(workspace: string, name: string): Agent | undefined {
    const row = this.#db
      .prepare(
        `SELECT ${AGENT_COLUMNS} FROM agent WHERE workspace = ? AND name = ? AND status = 'online'`,
      )
      .get(workspace, name) as AgentRow | undefined;
    return row ? toAgent(row) : undefined;
  }

  /**
   * peers lists the online agents of the workspace other than excludeId,
   * ordered by name, as Peer records.
   */
  peers(workspace: string, excludeId: string): Peer[] {
    const rows = this.#db
      .prepare(
        `SELECT ${AGENT_COLUMNS} FROM agent
         WHERE workspace = ? AND status = 'online' AND id != ? ORDER BY name`,
      )
      .all(workspace, excludeId) as unknown as AgentRow[];
    return rows.map(toPeer);
  }

  /**
   * onlineIds returns the ids of the online agents in the workspace, optionally
   * excluding one; used to fan out broadcasts and peer events.
   */
  onlineIds(workspace: string, excludeId?: string): string[] {
    const rows = this.#db
      .prepare(`SELECT id FROM agent WHERE workspace = ? AND status = 'online' AND id != ?`)
      .all(workspace, excludeId ?? '') as unknown as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * setOffline marks an online agent offline with the current time; a no-op for
   * agents already offline. The row stays for history.
   */
  setOffline(id: string): void {
    this.#db
      .prepare(
        `UPDATE agent SET status = 'offline', offline_at = ? WHERE id = ? AND status = 'online'`,
      )
      .run(now(), id);
  }

  /**
   * systemAgent returns the id of the workspace's system agent, creating it on
   * first use: an offline, never addressable row named GUARD_NAME that the
   * guard's notices are sent from. It holds no token, is never listed among
   * peers and cannot be registered, reclaimed or adopted.
   */
  systemAgent(workspace: string): string {
    const session = `${SYSTEM_SESSION_PREFIX}${workspace}`;
    const row = this.#rowBySession(session);
    if (row) return row.id;
    const id = newId('ag');
    const ts = now();
    this.#db
      .prepare(
        `INSERT INTO agent (id, name, workspace, description, capabilities, kind, session_id,
           window, provisional, token_hash, status, registered_at, last_seen, offline_at)
         VALUES (?, ?, ?, ?, ?, 'agent', ?, NULL, 0, '', 'offline', ?, ?, ?)`,
      )
      .run(
        id,
        GUARD_NAME,
        workspace,
        'The hub guard: reports quarantines and incidents to the humans of the workspace.',
        'none; it does not read replies',
        session,
        ts,
        ts,
        ts,
      );
    return id;
  }

  /**
   * findByName returns the agent a guard action names: the online agent with
   * that name in the workspace, else the most recently seen offline one, never
   * the system agent; undefined when no such agent exists.
   */
  findByName(workspace: string, name: string): Agent | undefined {
    const row = this.#db
      .prepare(
        `SELECT ${AGENT_COLUMNS} FROM agent
         WHERE workspace = ? AND name = ? AND session_id NOT LIKE '${SYSTEM_SESSION_PREFIX}%'
         ORDER BY status = 'online' DESC, last_seen DESC LIMIT 1`,
      )
      .get(workspace, name) as AgentRow | undefined;
    return row ? toAgent(row) : undefined;
  }

  /**
   * humanIds returns the ids of the identified human agents of the workspace,
   * online or not, optionally excluding one; guard notices go to them, and an
   * offline relay finds them in its mailbox when it returns.
   */
  humanIds(workspace: string, excludeId?: string): string[] {
    const rows = this.#db
      .prepare(
        `SELECT id FROM agent
         WHERE workspace = ? AND kind = 'human' AND provisional = 0 AND id != ?`,
      )
      .all(workspace, excludeId ?? '') as unknown as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * setQuarantine quarantines the agent with the given reason, or releases it
   * when reason is null; quarantining an agent that already is keeps the
   * original time and reason.
   */
  setQuarantine(id: string, reason: string | null): void {
    if (reason === null) {
      this.#db
        .prepare('UPDATE agent SET quarantined_at = NULL, quarantine_reason = NULL WHERE id = ?')
        .run(id);
      return;
    }
    this.#db
      .prepare(
        `UPDATE agent SET quarantined_at = ?, quarantine_reason = ?
         WHERE id = ? AND quarantined_at IS NULL`,
      )
      .run(now(), reason, id);
  }

  /** touch sets the agent's last_seen to now. */
  touch(id: string): void {
    this.#db.prepare('UPDATE agent SET last_seen = ? WHERE id = ?').run(now(), id);
  }

  /**
   * #rowBySession returns the raw agent row bound to a Claude Code session id
   * in any status, or undefined when no agent holds that session.
   *
   * It is a plain lookup on session_id with no workspace or online filter;
   * register and bySession use it to find the agent a session already belongs
   * to. At most one row is expected per session id.
   */
  #rowBySession(sessionId: string): AgentRow | undefined {
    return this.#db
      .prepare(`SELECT ${AGENT_COLUMNS} FROM agent WHERE session_id = ?`)
      .get(sessionId) as AgentRow | undefined;
  }

  /**
   * #mustGet returns the agent with that id in any status, throwing a plain
   * Error ("agent <id> vanished") when it does not exist.
   *
   * It is the re-read register performs right after inserting or updating a row
   * it knows exists, so a miss signals a corrupted or concurrently deleted row,
   * not a caller mistake: the error is not a HubError and reaches the client as
   * a 500.
   */
  #mustGet(id: string): Agent {
    const agent = this.byId(id);
    if (!agent) throw new Error(`agent ${id} vanished`);
    return agent;
  }

  /**
   * #uniqueName returns base when no other online agent in the workspace holds
   * that name, otherwise the first of base-2, base-3, ... that is free. The
   * reserved GUARD_NAME always counts as taken, so asking for it yields
   * guard-2 or later.
   *
   * Only online agents other than selfId count as taken: an offline namesake
   * does not force a suffix (register adopts or ignores it), and passing the
   * registering agent's own id lets it keep its current name on reclaim. The
   * check is a read with no lock, so two agents registering the same name at
   * the same instant could both receive base.
   */
  #uniqueName(workspace: string, base: string, selfId: string): string {
    const taken = this.#db.prepare(
      `SELECT 1 FROM agent WHERE workspace = ? AND name = ? AND status = 'online' AND id != ?`,
    );
    let candidate = base;
    for (
      let n = 2;
      candidate === GUARD_NAME || taken.get(workspace, candidate, selfId) !== undefined;
      n++
    ) {
      candidate = `${base}-${n}`;
    }
    return candidate;
  }
}
