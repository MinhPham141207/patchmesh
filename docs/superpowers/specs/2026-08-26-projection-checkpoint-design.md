# Projection checkpoint — read-path cost proportional to new events

Date: 2026-08-26
Status: approved for planning
Focus: read-path speed (user-selected from speed / data weight / startup)

## Problem

Every CLI process pays full replay. `readEvents` (`packages/query/src/services.ts:64`) calls
`reader.read()`, which parses and validates **every** event row, then `projectWorkGraph`
rebuilds the whole projection (~1.3s at 8.9k events). The in-memory window cache
(`packages/storage/src/event-cache.ts`) never hits in the CLI because each command is its own
process — by its own comment, "In the CLI... it simply never hits."

The projection is now linear (PM-19), but linear-per-call is still O(all events) on every
invocation against an append-only ledger where almost nothing changed since the last command.
Events are immutable and replay is deterministic, so re-deriving history on each read buys
nothing the ledger does not already guarantee.

## Goal

CLI read commands cost O(events appended since the last read) instead of O(entire ledger).
At this repository's 10k+ events, the dominant ~1.3s projection share of every `status`,
`agents`, `overlaps`, and recap-family command collapses toward tens of milliseconds.

## Non-goals

- No change to event schema, append path, or recorder/gateway hot path.
- No daemon or long-lived server (rejected approach; a checkpoint is also what a future
  daemon would hydrate from, so nothing here blocks that later).
- No reduction of the 2.2KB/event storage weight (separate problem, PM-18's residue).

## Design

### Storage

One checkpoint row in the existing SQLite database:

```sql
CREATE TABLE projection_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 0),
  projector_version TEXT NOT NULL,
  last_insertion_position INTEGER NOT NULL,
  state_blob BLOB NOT NULL,
  state_hash TEXT NOT NULL
);
```

Migration `004_projection_checkpoint.sql`, following the existing migration pattern. Single
row (`id = 0`): there is exactly one live checkpoint per ledger.

The watermark is `insertion_position` (AUTOINCREMENT PK in `001_events.sql`) — monotonic,
already indexed. Validity requires that the exact watermarked row still exists (`SELECT 1
FROM events WHERE insertion_position = ?`): `prune` deletes time-prefix rows including
possibly the watermarked one, so the existence probe is what invalidates the checkpoint on
prune — comparing against max alone would not, because pruning older rows leaves max
unchanged.

### Read flow

New function in `packages/storage`, used by query services in place of
`read-all + projectWorkGraph`:

1. Load the checkpoint. Reject it (fall through to full rebuild) if:
   - `projector_version` differs from the current projector code version;
   - `last_insertion_position` exceeds the current max `insertion_position`
     (truncated/pruned ledger);
   - `state_hash` does not verify against `state_blob`.
2. Read only rows with `insertion_position > watermark`, validating them exactly as today.
3. Apply them incrementally via `WorkGraphProjector`'s reducer (`applyEvent`,
   `packages/storage/src/work-graph.ts:345`), starting from the deserialized checkpoint
   state; derive views once at the end (the shape `buildProjection` already uses).
4. Serve the snapshot.
5. Best-effort persist the advanced state in one short transaction (`BEGIN IMMEDIATE` with a
   busy timeout). Any failure — lock contention, disk, corruption — skips the write silently;
   the next run catches up. Reads never fail because the checkpoint could not be written.

Step 5 makes a read command mutate storage. This is accepted deliberately: the write carries
no product information, only derived state that must be rebuildable at any time (AGENTS.md §10),
and the alternative is paying full replay until something else writes.

### Projector version

A constant exported next to `projectWorkGraph`. Bumped whenever projection output could change
for identical input (detector logic, coverage derivation, evidence merging). A mismatched
version is treated as no checkpoint at all — never as an error.

### Integrity

- Plain reads validate **new** events only and trust the hash-checked checkpoint for history.
- `patchmesh status --verify` forces full read + validation + full rebuild, reports its usual
  `Replayable` claim from that run, and rewrites the checkpoint afterwards. This keeps the
  claim honest while making the honest path opt-in rather than per-command tax.
- `doctor` runs `--verify` semantics so silent corruption is still discovered routinely.

### Freshness

`freshenLedger` (PM-17) already drains the journal before every report. After draining it also
applies the new events to the checkpoint, so the common read applies zero events. The MCP
gateway's long-lived window cache continues to work unchanged above this layer.

## Correctness bar

Serialized snapshots produced incrementally must be **byte-for-byte identical** to full replay
over the same frozen ledger — PM-19's proven comparison method (7,318,389-byte snapshot,
byte-equal). Every failure mode degrades to "do what we do today": full replay. The bug mode
introduced by this design is slowness, never wrong output.

## Error handling

| Failure | Behavior |
| --- | --- |
| Checkpoint missing / first run | Full rebuild, then persist |
| Version mismatch / prune / truncation | Discard checkpoint, full rebuild |
| Corrupt blob or hash mismatch | Discard checkpoint, full rebuild |
| Delta events fail validation | Surface the same error the current path would |
| Checkpoint write fails | Skip silently; serve the answer |

No new error surface reaches users except the `--verify` flag itself.

## Testing

- **Unit:** checkpoint round-trip; rejection on version bump, truncation, and corrupt
  blob/hash; delta read uses the watermark predicate.
- **Equivalence property:** incremental result ≡ full-replay result (byte-equal serialized
  snapshot) across randomized append sequences, including `attribution.corrected` forcing
  `rebuildProjection`.
- **Guard:** second consecutive read of an unchanged ledger applies zero events — asserted via
  an applied-events counter exposed alongside `eventCacheStats()`, following the cache-hit-
  counter precedent ("wired" vs "works").
- **Scaling:** extend the PM-19 guard's spirit — a read after appending k events must not touch
  the n already-projected ones (counter assertion, not wall clock).

## Open risks

- Deserialized `WorkGraphState` must round-trip exactly (Maps, ordering, evidence arrays).
  If exact serialization proves brittle, fallback shape: store the checkpointed *event id
  prefix* and rebuild by replaying only that prefix into memory before applying deltas — still
  bounded by ledger size but avoids state serialization entirely; decide during planning if
  the byte-identical bar fails against real ledger shapes.
