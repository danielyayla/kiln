import { createRequire } from "node:module";

// node:sqlite is still experimental, so it's absent from Node's builtinModules
// list and bundlers (Vite/tsup) try to resolve it as a file. Loading it through
// createRequire keeps it a pure runtime lookup that bundlers leave untouched.
// NOTE: on Node 22.x this requires the --experimental-sqlite flag; on Node 24+
// node:sqlite is stable and needs no flag. Swapping to better-sqlite3 is a
// drop-in change confined to this file (see README).
//
// The require is deferred until connect() runs (rather than at module load) so
// that merely importing @kiln/core doesn't touch node:sqlite — the single-file
// binary's startup guard (apps/desktop) relies on being able to import before
// the driver loads.
// Based on process.execPath (not import.meta.url) so the same source bundles
// cleanly to both ESM (dev sidecar) and CJS (the SEA binary) — for a builtin
// like node:sqlite the resolution base is irrelevant.
const nodeRequire = createRequire(process.execPath);
type SqliteModule = typeof import("node:sqlite");

// The DB type is derived without loading the module at runtime.
export type DB = InstanceType<SqliteModule["DatabaseSync"]>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT,
  assignee   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type    TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id, type);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_id, type);

CREATE TABLE IF NOT EXISTS suggestions (
  id         TEXT PRIMARY KEY,
  target_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  ops_json   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestions_target ON suggestions(target_id);

CREATE TABLE IF NOT EXISTS revisions (
  id         TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_entity ON revisions(entity_id);

-- Context provenance (Phase 8): an immutable snapshot of the assembled context
-- handed to an agent for a work order, at delivery time.
CREATE TABLE IF NOT EXISTS context_receipts (
  id            TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  context_json  TEXT NOT NULL,
  hash          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_receipts_wo ON context_receipts(work_order_id);

-- Completion receipts: the return half of the handoff loop — an agent's
-- immutable report of what came back (what was built, how it was verified,
-- code testimony) filed when a work order is closed. Append-only, never
-- updated or deleted, never deduped.
CREATE TABLE IF NOT EXISTS completion_receipts (
  id                 TEXT PRIMARY KEY,
  work_order_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  summary            TEXT NOT NULL,
  verification       TEXT NOT NULL,
  commits_json       TEXT NOT NULL,
  branch             TEXT,
  files_touched_json TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_completion_receipts_wo ON completion_receipts(work_order_id);

-- Verification receipts: an independent judgment of a done work order's
-- completion receipt(s) against its acceptance criteria — per-criterion
-- verdicts plus an overall one. Append-only and immutable like completion
-- receipts; re-verification appends a new row.
CREATE TABLE IF NOT EXISTS verification_receipts (
  id            TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  criteria_json TEXT NOT NULL,
  overall       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_receipts_wo ON verification_receipts(work_order_id);

-- AI settings & usage: host-level configuration (opaque string values; the
-- consumer parses booleans etc.) and the one-row-per-model-call ledger.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_usage (
  id            TEXT PRIMARY KEY,
  feature       TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  id UNINDEXED, type UNINDEXED, title, body
);
`;

// Opens (or creates) a SQLite database, sets the pragmas that let a second
// process (the MCP server) safely share the file, and applies the schema.
export function connect(path = ":memory:"): DB {
  const { DatabaseSync } = nodeRequire("node:sqlite") as SqliteModule;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive migrations for stores created before a column existed. Each step is
// guarded by table_info, so re-opening an up-to-date store is a no-op.
function migrate(db: DB): void {
  const entityColumns = db.prepare("PRAGMA table_info(entities)").all() as unknown as {
    name: string;
  }[];
  if (!entityColumns.some((c) => c.name === "work_type")) {
    db.exec("ALTER TABLE entities ADD COLUMN work_type TEXT");
    // One-time backfill (BP-18): translate the legacy `[bug]`-style title
    // convention into the field. Titles are testimony and stay untouched;
    // `feature` is not a recognized prefix — capability work carries none.
    const backfill = db.prepare(
      "UPDATE entities SET work_type = ? WHERE type = 'work_order' AND work_type IS NULL AND title LIKE ?",
    );
    for (const t of ["bug", "refactor", "perf", "chore"]) backfill.run(t, `[${t}]%`);
  }
  if (!entityColumns.some((c) => c.name === "criticality")) {
    // No backfill: there is no legacy convention to translate. NULL means
    // "unset" and effectiveCriticality resolves it to routine at read time.
    db.exec("ALTER TABLE entities ADD COLUMN criticality TEXT");
  }
}
