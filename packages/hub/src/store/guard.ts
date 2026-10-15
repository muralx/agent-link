import type { DatabaseSync } from 'node:sqlite';
import {
  GUARD_NAME,
  newId,
  type Agent,
  type GuardRule,
  type Incident,
  type IncidentAction,
  type QuarantinedAgent,
  type Recipients,
} from '@agent-link/protocol';
import { now } from './db.ts';

/**
 * GuardLimits are the thresholds of the guard's automatic rules. Each rule
 * allows up to its maximum inside its window and refuses the next send.
 */
export interface GuardLimits {
  /** ratePerMinute is how many messages one agent may send in 60 s. */
  ratePerMinute: number;
  /**
   * loopMax is how many messages a conversation may gather inside loopWindowMs
   * without any of them coming from a human.
   */
  loopMax: number;
  /** loopWindowMs is the window of the loop rule. */
  loopWindowMs: number;
  /**
   * repeatMax is how many times one agent may send the same body inside
   * repeatWindowMs.
   */
  repeatMax: number;
  /** repeatWindowMs is the window of the repeat rule. */
  repeatWindowMs: number;
  /**
   * broadcastMax is how many "*" sends one agent may make inside
   * broadcastWindowMs.
   */
  broadcastMax: number;
  /** broadcastWindowMs is the window of the broadcast rule. */
  broadcastWindowMs: number;
}

/**
 * DEFAULT_GUARD_LIMITS are the limits a hub runs with unless told otherwise: 30
 * messages a minute per agent, 50 messages in ten minutes in one conversation
 * with no human, the same body 5 times in ten minutes, 5 broadcasts in ten
 * minutes.
 */
export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  ratePerMinute: 30,
  loopMax: 50,
  loopWindowMs: 600_000,
  repeatMax: 5,
  repeatWindowMs: 600_000,
  broadcastMax: 5,
  broadcastWindowMs: 600_000,
};

/** Violation names the rule a send would break and says why in prose. */
export interface Violation {
  /** rule is the rule the send would break. */
  rule: GuardRule;
  /**
   * detail says in prose what was counted and the limit, for the incident and
   * the notice.
   */
  detail: string;
}

/**
 * SendAttempt is what the guard looks at before a message is stored: the
 * recipients asked for, the body and the conversation it continues, if any.
 */
export interface SendAttempt {
  /**
   * to is the recipients asked for, '*' for a broadcast, or undefined for a
   * reply into a conversation.
   */
  to?: Recipients | undefined;
  /** body is the message text, compared verbatim by the repeat rule. */
  body: string;
  /**
   * conversationId is the conversation continued, checked by the loop rule;
   * undefined for a new conversation.
   */
  conversationId?: string | undefined;
}

/** RecordIncident is the input of GuardStore.record. */
export interface RecordIncident {
  /** workspace is the workspace the incident belongs to. */
  workspace: string;
  /** agentId is the agent the incident is about. */
  agentId: string;
  /** rule is what the incident is about. */
  rule: GuardRule;
  /** action is what was done: quarantined, released, requested or flagged. */
  action: IncidentAction;
  /** detail is the prose reason shown in the log and the notice. */
  detail: string;
  /** byId is the agent that caused the incident, or undefined for the hub. */
  byId?: string | undefined;
}

/** IncidentRow is the raw row shape of the incident listing query. */
interface IncidentRow {
  /** id is the incident id (inc_...). */
  id: string;
  /** agent is the current name of the agent the incident is about. */
  agent: string;
  /** rule is what the incident is about. */
  rule: GuardRule;
  /** action is what was done. */
  action: IncidentAction;
  /** detail is the prose reason. */
  detail: string;
  /**
   * by is the current name of the agent that caused it, or null for the hub's
   * own rules.
   */
  by: string | null;
  /** created_at is when the incident was recorded (ISO 8601). */
  created_at: string;
}

/**
 * GuardStore owns the incident table and evaluates the guard's automatic rules
 * against the message table. Rate, loop and repeat are counted from stored
 * messages, so they survive a hub restart; broadcasts are counted in memory,
 * since a stored message does not say it was addressed to "*". The quarantine
 * flag itself lives on the agent row (AgentStore.setQuarantine).
 */
export class GuardStore {
  /** #db is the hub's open database. */
  readonly #db: DatabaseSync;
  /** #limits are the thresholds the rules enforce. */
  readonly #limits: GuardLimits;
  /**
   * #broadcasts holds, per sender id, the times (ms) of its recent "*" sends;
   * it is pruned to the broadcast window on each check and lost on restart.
   */
  readonly #broadcasts = new Map<string, number[]>();

  /**
   * Builds a GuardStore over an open database whose schema already exists,
   * with the limits its rules enforce.
   */
  constructor(db: DatabaseSync, limits: GuardLimits = DEFAULT_GUARD_LIMITS) {
    this.#db = db;
    this.#limits = limits;
  }

  /**
   * check returns the first rule the sender's next message would break at
   * nowMs, or undefined when it may be sent. A human sender is never checked.
   * Rules are tried in the order rate, repeat, broadcast, loop. A broadcast
   * that passes is counted, so call check once per attempted send.
   */
  check(sender: Agent, attempt: SendAttempt, nowMs: number = Date.now()): Violation | undefined {
    if (sender.kind === 'human') return undefined;
    const limits = this.#limits;
    const since = (windowMs: number): string => new Date(nowMs - windowMs).toISOString();

    const sent = this.#count(
      'SELECT COUNT(*) AS n FROM message WHERE from_agent = ? AND created_at >= ?',
      sender.id,
      since(60_000),
    );
    if (sent >= limits.ratePerMinute) {
      return {
        rule: 'rate',
        detail: `sent ${sent} messages in the last minute (limit ${limits.ratePerMinute})`,
      };
    }

    const repeats = this.#count(
      'SELECT COUNT(*) AS n FROM message WHERE from_agent = ? AND body = ? AND created_at >= ?',
      sender.id,
      attempt.body,
      since(limits.repeatWindowMs),
    );
    if (repeats >= limits.repeatMax) {
      return {
        rule: 'repeat',
        detail: `sent the same message ${repeats} times in the last ${minutes(limits.repeatWindowMs)} (limit ${limits.repeatMax})`,
      };
    }

    if (attempt.to === '*') {
      const recent = (this.#broadcasts.get(sender.id) ?? []).filter(
        (t) => t > nowMs - limits.broadcastWindowMs,
      );
      if (recent.length >= limits.broadcastMax) {
        this.#broadcasts.set(sender.id, recent);
        return {
          rule: 'broadcast',
          detail: `broadcast ${recent.length} times in the last ${minutes(limits.broadcastWindowMs)} (limit ${limits.broadcastMax})`,
        };
      }
      recent.push(nowMs);
      this.#broadcasts.set(sender.id, recent);
    }

    if (attempt.conversationId !== undefined) {
      const run = this.#count(
        `SELECT COUNT(*) AS n FROM message m
         WHERE m.conversation_id = ? AND m.created_at >= ?
           AND m.rowid > COALESCE(
             (SELECT MAX(h.rowid) FROM message h JOIN agent a ON a.id = h.from_agent
              WHERE h.conversation_id = ? AND a.kind = 'human'), 0)`,
        attempt.conversationId,
        since(limits.loopWindowMs),
        attempt.conversationId,
      );
      if (run >= limits.loopMax) {
        return {
          rule: 'loop',
          detail: `conversation ${attempt.conversationId} gathered ${run} messages in the last ${minutes(limits.loopWindowMs)} with no human taking part (limit ${limits.loopMax})`,
        };
      }
    }
    return undefined;
  }

  /** record appends one incident to the log and returns it. */
  record(input: RecordIncident): Incident {
    const id = newId('inc');
    this.#db
      .prepare(
        `INSERT INTO incident (id, workspace, agent_id, rule, action, detail, by_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspace,
        input.agentId,
        input.rule,
        input.action,
        input.detail,
        input.byId ?? null,
        now(),
      );
    const row = this.#db
      .prepare(`${INCIDENT_SELECT} WHERE i.id = ?`)
      .get(id) as unknown as IncidentRow;
    return toIncident(row);
  }

  /**
   * incidents returns the workspace's most recent incidents, newest first, at
   * most limit.
   */
  incidents(workspace: string, limit = 50): Incident[] {
    const rows = this.#db
      .prepare(`${INCIDENT_SELECT} WHERE i.workspace = ? ORDER BY i.rowid DESC LIMIT ?`)
      .all(workspace, limit) as unknown as IncidentRow[];
    return rows.map(toIncident);
  }

  /**
   * quarantined lists the agents of the workspace that are quarantined now,
   * longest first.
   */
  quarantined(workspace: string): QuarantinedAgent[] {
    return this.#db
      .prepare(
        `SELECT name, status, COALESCE(quarantine_reason, '') AS reason, quarantined_at AS since
         FROM agent WHERE workspace = ? AND quarantined_at IS NOT NULL ORDER BY quarantined_at`,
      )
      .all(workspace) as unknown as QuarantinedAgent[];
  }

  /** #count runs a COUNT(*) AS n query and returns n. */
  #count(sql: string, ...args: string[]): number {
    return (this.#db.prepare(sql).get(...args) as { n: number }).n;
  }
}

/**
 * INCIDENT_SELECT is the shared SELECT that resolves an incident's agent and
 * author ids to their current names.
 */
const INCIDENT_SELECT = `
  SELECT i.id, a.name AS agent, i.rule, i.action, i.detail, b.name AS "by", i.created_at
  FROM incident i JOIN agent a ON a.id = i.agent_id LEFT JOIN agent b ON b.id = i.by_agent`;

/**
 * toIncident maps an incident row to the protocol Incident; an incident with no
 * author was raised by the hub's own rules and is attributed to GUARD_NAME.
 */
function toIncident(row: IncidentRow): Incident {
  return { ...row, by: row.by ?? GUARD_NAME };
}

/** minutes renders a window length in whole minutes for an incident detail. */
function minutes(ms: number): string {
  const n = Math.round(ms / 60_000);
  return n === 1 ? 'minute' : `${n} minutes`;
}
