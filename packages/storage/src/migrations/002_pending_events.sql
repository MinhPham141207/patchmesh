-- Append-time out-of-order buffering (Phase 2 M1).
--
-- An event whose causal parent is not yet durable is held here instead of being
-- committed into `events`. This keeps the durable log causally closed at all times,
-- so replay can never observe a dangling causation reference, while still tolerating
-- out-of-order arrival from an unordered transport.
--
-- Rows leave this table only by promotion into `events` once their parent lands.
-- A row whose parent never arrives stays quarantined rather than degrading replay.

CREATE TABLE IF NOT EXISTS pending_events (
  buffered_position INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  content_digest TEXT NOT NULL,
  canonical_event BLOB NOT NULL,
  causation_id TEXT NOT NULL,
  buffered_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS pending_events_causation_idx ON pending_events (causation_id);
CREATE INDEX IF NOT EXISTS pending_events_position_idx ON pending_events (buffered_position);
