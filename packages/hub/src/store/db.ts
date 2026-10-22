import { DatabaseSync } from 'node:sqlite';

/**
 * SCHEMA is the complete DDL (CREATE ... IF NOT EXISTS) for the six tables of
 * spec §4, including the agent's provisional flag and the window id on agent
 * and session, plus the partial unique index that keeps names unique among
 * online agents of a workspace, the guard's columns on agent (watcher,
 * quarantined_at, quarantine_reason), its incident table and the
 * conversation kind (direct, announcement or group). Columns added
 * after the first release are also listed in MIGRATIONS so existing files
 * catch up.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workspace     TEXT NOT NULL,
  description   TEXT NOT NULL,
  capabilities  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('agent', 'human')),
  session_id    TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('online', 'offline')),
  registered_at TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  offline_at    TEXT,
  provisional   INTEGER NOT NULL DEFAULT 0,
  window        TEXT,
  watcher       INTEGER NOT NULL DEFAULT 0,
  quarantined_at    TEXT,
  quarantine_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_online_name ON agent(workspace, name) WHERE status = 'online';
CREATE INDEX IF NOT EXISTS agent_session ON agent(session_id);
CREATE INDEX IF NOT EXISTS agent_window ON agent(window);
CREATE INDEX IF NOT EXISTS agent_token ON agent(token_hash);

CREATE TABLE IF NOT EXISTS conversation (
  id         TEXT PRIMARY KEY,
  workspace  TEXT NOT NULL,
  subject    TEXT,
  kind       TEXT NOT NULL DEFAULT 'group' CHECK (kind IN ('direct', 'announcement', 'group')),
  created_by TEXT NOT NULL REFERENCES agent(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participant (
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  agent_id        TEXT NOT NULL REFERENCES agent(id),
  joined_at       TEXT NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
);

CREATE TABLE IF NOT EXISTS message (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  from_agent      TEXT NOT NULL REFERENCES agent(id),
  to_names        TEXT NOT NULL,
  body            TEXT NOT NULL,
  expectation     TEXT NOT NULL CHECK (expectation IN ('reply', 'none', 'updates')),
  final           INTEGER NOT NULL DEFAULT 0,
  in_reply_to     TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_conv_created ON message(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS delivery (
  message_id  TEXT NOT NULL REFERENCES message(id),
  to_agent    TEXT NOT NULL REFERENCES agent(id),
  state       TEXT NOT NULL CHECK (state IN ('queued', 'notified', 'read')),
  via         TEXT,
  notified_at TEXT,
  read_at     TEXT,
  nag_count   INTEGER NOT NULL DEFAULT 0,
  answers     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, to_agent)
);
CREATE INDEX IF NOT EXISTS delivery_to_state ON delivery(to_agent, state);

CREATE TABLE IF NOT EXISTS incident (
  id         TEXT PRIMARY KEY,
  workspace  TEXT NOT NULL,
  agent_id   TEXT NOT NULL REFERENCES agent(id),
  rule       TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL,
  by_agent   TEXT REFERENCES agent(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_ws_created ON incident(workspace, created_at);

CREATE TABLE IF NOT EXISTS session (
  session_id     TEXT PRIMARY KEY,
  cwd            TEXT,
  workspace_hint TEXT,
  window         TEXT,
  agent_id       TEXT REFERENCES agent(id),
  created_at     TEXT NOT NULL
);
`;

/**
 * openDatabase opens (creating if needed) the SQLite file at path, switches it
 * to WAL with foreign keys and a 5 s busy timeout, adds any columns an older
 * file lacks (migrate) and applies the schema idempotently; ':memory:' gives a
 * throwaway database for tests.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  db.exec(SCHEMA);
  return db;
}

/**
 * MIGRATIONS lists columns added after the first release as [table, column,
 * definition]; migrate adds each one that an existing database lacks. The
 * guard's agent columns (watcher, quarantined_at, quarantine_reason) came
 * next; then the conversation kind, and conversations that predate it become
 * groups, which is how they behaved; the latest is delivery.answers, which marks
 * a delivery that answers a question the recipient is waiting on (deliveries
 * that predate it answer nothing, which is how they behaved).
 */
const MIGRATIONS: [table: string, column: string, definition: string][] = [
  ['agent', 'provisional', 'INTEGER NOT NULL DEFAULT 0'],
  ['agent', 'window', 'TEXT'],
  ['session', 'window', 'TEXT'],
  ['agent', 'watcher', 'INTEGER NOT NULL DEFAULT 0'],
  ['agent', 'quarantined_at', 'TEXT'],
  ['agent', 'quarantine_reason', 'TEXT'],
  ['conversation', 'kind', "TEXT NOT NULL DEFAULT 'group'"],
  ['delivery', 'answers', 'INTEGER NOT NULL DEFAULT 0'],
];

/**
 * migrate brings a database created by an earlier version up to the current
 * schema by adding the columns in MIGRATIONS that are missing; a fresh or
 * current database is left untouched.
 */
function migrate(db: DatabaseSync): void {
  for (const [table, column, definition] of MIGRATIONS) {
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!exists) continue;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * now returns the current time as an ISO 8601 string, the timestamp format used
 * in every table.
 */
export function now(): string {
  return new Date().toISOString();
}
