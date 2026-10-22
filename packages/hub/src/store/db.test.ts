import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.ts';

const TABLES = [
  'agent',
  'conversation',
  'delivery',
  'incident',
  'message',
  'participant',
  'session',
];

test('openDatabase creates the schema', () => {
  const db = openDatabase(':memory:');
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  assert.deepEqual(
    rows.map((r) => r.name).filter((n) => !n.startsWith('sqlite_')),
    TABLES,
  );
  db.close();
});

test('openDatabase is idempotent on an existing file and enables WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-link-db-'));
  const path = join(dir, 'x.db');
  openDatabase(path).close();
  const db = openDatabase(path);
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  assert.equal(mode.journal_mode, 'wal');
  db.close();
});

test('an older database gains the provisional, window and guard columns on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-link-migrate-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE agent (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL, description TEXT NOT NULL,
    capabilities TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL, token_hash TEXT NOT NULL,
    status TEXT NOT NULL, registered_at TEXT NOT NULL, last_seen TEXT NOT NULL, offline_at TEXT)`);
  old.exec(
    `INSERT INTO agent VALUES ('ag_1','a','w','d','c','agent','s','h','offline','t','t',NULL)`,
  );
  old.exec(`CREATE TABLE session (session_id TEXT PRIMARY KEY, cwd TEXT, workspace_hint TEXT,
    agent_id TEXT REFERENCES agent(id), created_at TEXT NOT NULL)`);
  old.close();

  const db = openDatabase(path);
  const row = db
    .prepare('SELECT provisional, window, watcher, quarantined_at FROM agent WHERE id = ?')
    .get('ag_1') as {
    provisional: number;
    window: string | null;
    watcher: number;
    quarantined_at: string | null;
  };
  assert.deepEqual({ ...row }, { provisional: 0, window: null, watcher: 0, quarantined_at: null });
  const cols = (db.prepare('PRAGMA table_info(session)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(cols.includes('window'));
  openDatabase(path).close();
  db.close();
});

test('conversations from before kinds become groups, so their replies still reach everyone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-link-kind-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE conversation (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, subject TEXT,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL)`);
  old.exec(`INSERT INTO conversation VALUES ('cv_1','w',NULL,'ag_1','t')`);
  old.close();
  const db = openDatabase(path);
  const row = db.prepare('SELECT kind FROM conversation WHERE id = ?').get('cv_1') as {
    kind: string;
  };
  assert.equal(row.kind, 'group');
  db.close();
});

test('deliveries from before answers answer nothing, so they wake as they did', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-link-answers-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE delivery (message_id TEXT NOT NULL, to_agent TEXT NOT NULL,
    state TEXT NOT NULL, via TEXT, notified_at TEXT, read_at TEXT,
    nag_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (message_id, to_agent))`);
  old.exec(`INSERT INTO delivery (message_id, to_agent, state) VALUES ('msg_1','ag_1','queued')`);
  old.close();
  const db = openDatabase(path);
  const row = db.prepare('SELECT answers FROM delivery WHERE message_id = ?').get('msg_1') as {
    answers: number;
  };
  assert.equal(row.answers, 0);
  db.close();
});
