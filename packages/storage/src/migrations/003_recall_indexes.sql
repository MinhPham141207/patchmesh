-- Recall reads a time window, not the whole ledger.
--
-- Every gateway answer used to load every event ever recorded and filter in JavaScript, so the
-- cost of asking "who touched this file in the last four hours" grew with total history rather
-- than with the window. These indexes let the window and the event type reach SQLite instead.
CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events (timestamp);
CREATE INDEX IF NOT EXISTS events_type_timestamp_idx ON events (event_type, timestamp);
