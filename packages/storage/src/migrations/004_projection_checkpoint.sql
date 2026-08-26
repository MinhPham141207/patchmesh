CREATE TABLE IF NOT EXISTS projection_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 0),
  projector_version TEXT NOT NULL,
  last_insertion_position INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  state_blob TEXT NOT NULL
);
