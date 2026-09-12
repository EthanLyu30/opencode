export const RUN_DATABASE_SCHEMA_VERSION = 1

export const RUN_DATABASE_SQL = `
CREATE TABLE IF NOT EXISTS benchmark_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS campaigns (
  campaign_id TEXT PRIMARY KEY NOT NULL,
  campaign_sha256 TEXT UNIQUE NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('offline', 'pilot', 'campaign')),
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tasks (
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  task_id TEXT NOT NULL,
  PRIMARY KEY (campaign_id, task_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS arms (
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  arm_id TEXT NOT NULL CHECK (arm_id IN ('A', 'B', 'C', 'D', 'E')),
  PRIMARY KEY (campaign_id, arm_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  task_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  repetition INTEGER NOT NULL,
  order_index INTEGER NOT NULL,
  state TEXT NOT NULL,
  UNIQUE (campaign_id, task_id, arm_id, repetition),
  UNIQUE (campaign_id, order_index)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'interrupted', 'canceled')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_attempt_per_run ON attempts(run_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS leases (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(run_id),
  owner_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  generation INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS state_events (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  sequence INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS state_events_no_update BEFORE UPDATE ON state_events
  BEGIN SELECT RAISE(ABORT, 'TASK24_STATE_EVENTS_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS state_events_no_delete BEFORE DELETE ON state_events
  BEGIN SELECT RAISE(ABORT, 'TASK24_STATE_EVENTS_APPEND_ONLY'); END;
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  provider TEXT NOT NULL,
  currency TEXT NOT NULL,
  reserved_micros TEXT NOT NULL,
  state TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS request_ledgers (
  request_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  request_sha256 TEXT NOT NULL,
  response_sha256 TEXT,
  disposition TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS process_records (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(attempt_id),
  pid INTEGER NOT NULL,
  executable_sha256 TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  classification TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  relative_path TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS evaluations (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(run_id),
  evaluator_sha256 TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  completed_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adjudications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cancellation_requests (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(run_id),
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed'))
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS report_builds (
  report_id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  input_sha256 TEXT NOT NULL,
  output_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
`
