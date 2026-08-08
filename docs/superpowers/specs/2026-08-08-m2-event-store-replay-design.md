# M2 Event Store and Replay Design

**Status:** Approved design; implementation pending.

## Goal

M2 makes the normalized Phase 1 event stream durable and replayable. It adds an
append-only SQLite event store and a deterministic replay core without adding runtime
adapters, graph projections, detectors, policies, CLI commands, or external side
effects.

The implementation follows the M2 contract in
[`docs/implementation/phase1/PHASE_1_MILESTONES.md`](../../implementation/phase1/PHASE_1_MILESTONES.md): events survive process
restart, identical duplicates are no-ops, conflicting duplicates fail
deterministically, causal order is preserved without wall-clock repair, and failed
replay never exposes a partial success snapshot.

## Scope

### Included

- A new `packages/storage` package.
- SQLite database opening and versioned migrations.
- Append-only persistence for validated `ProtocolEvent` values.
- Canonical event JSON and SHA-256 content digests.
- Duplicate and conflicting-ID handling.
- Raw event reads and deterministic causal replay.
- Explicit source-sequence gap diagnostics.
- Temporary-database repository and replay tests.

### Excluded

- MCP or other runtime adapters.
- Tool interception or effect observation.
- Work-graph or other derived projections.
- Detector findings, coordination decisions, and policy behavior.
- Daemon, HTTP, CLI, dashboard, or distributed storage.
- Event signing, authentication, sandboxing, or remote storage.

## Architecture

`packages/storage` depends on `@patchmesh/protocol` only. The protocol remains
runtime-agnostic and the storage package does not depend on the in-memory collector.
Callers submit untrusted input to the storage boundary; storage parses and validates
it before persistence.

The package has three focused parts:

1. `SqliteDatabase` opens a SQLite file and applies migrations.
2. `SqliteEventStore` owns append-only event persistence and raw reads.
3. `ReplayDriver` consumes the immutable event set and produces an in-memory replay
   result without writing to the database or calling external services.

The implementation uses Node's built-in `node:sqlite` `DatabaseSync` API. The package
documents a minimum Node version that supports that API; the current workspace's
Node 22 type dependency is the baseline for implementation. No ORM is introduced.

## Database Schema

Migrations are immutable files applied in ascending identifier order. An applied
migration is never edited; a later schema change receives a new migration.

Migration `001_events` creates:

### `schema_migrations`

- `migration_id TEXT PRIMARY KEY`
- `applied_at TEXT NOT NULL`

### `events`

- `insertion_position INTEGER PRIMARY KEY AUTOINCREMENT`
- `event_id TEXT NOT NULL UNIQUE`
- `content_digest TEXT NOT NULL`
- `canonical_event BLOB NOT NULL`
- `schema_version INTEGER NOT NULL`
- `event_type TEXT NOT NULL`
- `source_kind TEXT NOT NULL`
- `source_id TEXT NOT NULL`
- `source_instance_id TEXT NOT NULL`
- `source_sequence INTEGER`
- `timestamp TEXT NOT NULL`
- `repository_id TEXT NOT NULL`
- `workspace_id TEXT NOT NULL`
- `worktree_id TEXT NOT NULL`
- `agent_id TEXT`
- `task_id TEXT`
- `correlation_id TEXT NOT NULL`
- `causation_id TEXT`

The canonical event is stored as UTF-8 bytes and is the durable source of truth.
Metadata columns make indexed reads and diagnostics possible, but there is no update
API that can change metadata or event bytes. `causation_id` is not a foreign key:
valid events may be appended before their parent arrives.

Indexes are limited to the access patterns required by M2:

- unique event ID for idempotency;
- content digest for diagnostics and duplicate lookup;
- causation ID for replay reference lookup;
- insertion position for raw log order.

Migrations run inside a transaction and are safe to rerun. SQLite foreign keys are
enabled, but causal references remain application-level because out-of-order arrival
is supported.

## Canonicalization and Append

`append(input: unknown)` performs these steps in one transaction:

1. Parse the input through the existing protocol boundary.
2. Canonicalize JSON by recursively sorting object keys, preserving array order, and
   encoding the result as UTF-8.
3. Hash the canonical bytes with SHA-256.
4. Look up the event ID.
5. If no row exists, insert the complete event and metadata.
6. If the row exists with the same digest, roll back the attempted insert and return
   an idempotent `duplicate` result.
7. If the row exists with a different digest, roll back and throw the deterministic
   `PHASE0_ID_CONFLICT` storage error.

The transaction boundary prevents a partially written event. Duplicate handling does
not create a second insertion position. Stored event bytes are never rewritten.

Append validates the individual event envelope and payload but does not require a
causal parent to already exist. Full event-set semantic validation is performed by
replay after the complete causal input is available.

## Raw Reads

Raw reads return protocol events reconstructed from the stored canonical bytes. The
default raw-log order is ascending `insertion_position`, which reflects durable
arrival order and is useful for diagnostics. Returned values are cloned and frozen so
callers cannot mutate storage-owned data.

The repository exposes narrow filters for event ID, event type, correlation ID, and
causation ID. It does not expose SQL or table handles to callers.

## Replay

Replay first reads the event set and performs all work in memory. It does not mutate
the database, rerun tools, send decisions, execute directives, or dispatch delivery
state.

The driver builds a pending set keyed by event ID and a set of resolved causal IDs.
Events with a null causation ID are initially ready. An event becomes ready only when
its direct causation event has been resolved. Ready events are selected using a
deterministic event-ID tie-breaker, never by timestamp or insertion position. This
produces the same causal input order for the canonical, duplicate, and valid
out-of-order forms of an event set.

The driver repeatedly resolves ready events until the pending set is empty. The
number of resolution passes is bounded by the number of stored events. If no pending
event can become ready:

- a causation ID absent from the event set produces `PHASE0_REFERENCE_MISSING`;
- a closed causal cycle or otherwise unresolved dependency produces the deterministic
  `M2_REPLAY_CAUSALITY_UNRESOLVED` error.

After causal resolution, the complete event set is passed through protocol semantic
validation. Impossible transitions produce `PHASE0_TRANSITION_INVALID`. No reducer
state is returned for any replay error.

The replay result contains:

- the deterministically ordered immutable event input;
- source-sequence gap diagnostics grouped by
  `(source.kind, source.sourceId, source.instanceId)`;
- the reducer state when a pure reducer is supplied.

Source-sequence gaps are explicit degraded coverage. They do not create causal edges,
synthetic events, or replay failure.

The default reducer is an event accumulator for M2 tests. A reducer interface is
provided for later projection work, but M2 does not implement a graph projector or
other derived state.

## Error Handling

Storage errors are typed and include stable codes plus safe identifiers. Diagnostics
must not echo secrets or arbitrary payload values. The public error categories are:

- protocol boundary rejection;
- `PHASE0_ID_CONFLICT` for one ID with different canonical content;
- `PHASE0_REFERENCE_MISSING` for an absent causal parent;
- `M2_REPLAY_CAUSALITY_UNRESOLVED` for a causal cycle or bounded replay failure;
- `PHASE0_TRANSITION_INVALID` for impossible event-set transitions;
- migration/open failures for database setup problems.

Replay failure is atomic from the caller's perspective: the caller receives an error,
not a partial snapshot. Appending valid events remains durable even when a later
replay attempt reports an unresolved parent; once the parent is appended, replay can
be retried against the same event log.

## Verification

Tests use isolated temporary SQLite files and close each database after the test.
The M2 suite must cover:

- migration creation, rerun safety, and process-restart persistence;
- canonical digest stability when input object keys are ordered differently;
- immutable stored bytes and frozen read results;
- identical duplicate no-op behavior;
- conflicting duplicate IDs and stable error codes;
- canonical, duplicate, and causally out-of-order replay convergence;
- missing causal parents and causal cycles with no partial result;
- impossible transitions with no partial result;
- source-sequence gaps reported as degraded coverage;
- reducer isolation from database writes and external side effects.

The package must pass its own tests, strict typechecking, and build. The existing
protocol and collector suites must remain green, followed by the repository-wide
`test`, `typecheck`, and `build` scripts.

## Documentation and Exit Evidence

Implementation updates will add M2 evidence documenting migration, restart,
idempotency, conflict, replay-equivalence, causal-failure, and source-gap results.
The M2 milestone is not marked complete until the documented exit evidence and tests
pass. Current roadmap and milestone documents remain marked according to actual
implementation status until that verification is complete.

M2 completion does not change the Phase 1 report-only boundary and does not authorize
M3 runtime integration or M5 projections.
