CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  insertion_position INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  content_digest TEXT NOT NULL,
  canonical_event BLOB NOT NULL,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_sequence INTEGER,
  timestamp TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT
);

CREATE INDEX IF NOT EXISTS events_digest_idx ON events (content_digest);
CREATE INDEX IF NOT EXISTS events_causation_idx ON events (causation_id);
CREATE INDEX IF NOT EXISTS events_position_idx ON events (insertion_position);
