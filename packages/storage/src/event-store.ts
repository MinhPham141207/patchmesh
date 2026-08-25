import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import {
  parseEvent,
  ProtocolValidationError,
  type CorrelationId,
  type EventId,
  type EventType,
  type ProtocolEvent,
  validateEventSet,
} from "patchmesh-protocol";
import { canonicalBytes, canonicalDigest } from "./canonical-json.js";
import { openDatabase } from "./database.js";
import { StorageError } from "./errors.js";
import {
  replayEvents,
  type ReplayReducer,
  type ReplayResult,
  type SourceSequenceGap,
} from "./replay.js";

export interface EventQuery {
  readonly eventId?: EventId;
  readonly eventType?: EventType;
  /**
   * Any of these event types, for a reader that wants two or three of them and not the rest.
   *
   * Recall reads calls and observed changes; overlap reads only changes - 51 of this
   * repository's 1,165 events. Loading the other 1,114 to discard them in JavaScript is the
   * shape of cost that does not show up until a ledger has been used for a while.
   */
  readonly eventTypes?: readonly EventType[];
  readonly correlationId?: CorrelationId;
  readonly causationId?: EventId | null;
  /** Inclusive lower bound on `timestamp`, ISO-8601. A window, pushed to SQLite. */
  readonly since?: string;
}

/**
 * How much a reader wants proved about what it reads.
 *
 * `validate: false` says "I am answering a question, not deciding integrity" -- see
 * `reconstructStoredEvent` for why that is safe and what it is worth. The default is true so
 * that a reader gets the checked path unless it has said otherwise.
 */
export interface ReadOptions {
  readonly validate?: boolean;
}

export interface PruneResult {
  readonly removed: number;
  readonly retained: number;
}

export type AppendResult =
  | { readonly status: "inserted"; readonly event: ProtocolEvent }
  | { readonly status: "duplicate"; readonly event: ProtocolEvent }
  | { readonly status: "buffered"; readonly event: ProtocolEvent };

export interface AtomicAppendOptions {
  /** Validates the locked durable snapshot and all genuinely new candidates as one set. */
  readonly requireValidEventSet?: boolean;
  /**
   * Holds a candidate whose causal parent is not yet durable in the pending buffer
   * instead of committing it, and promotes buffered events once their parent lands.
   * Without this, an out-of-order child is inserted directly and the durable log
   * carries a dangling causation reference until its parent arrives.
   */
  readonly bufferUnresolvedCausalParents?: boolean;
}

export type { ReplayReducer, ReplayResult, SourceSequenceGap } from "./replay.js";

interface StoredRow {
  readonly event_id: string;
  readonly content_digest: string;
  readonly canonical_event: Uint8Array | string;
  /**
   * Read so an unchecked read can tell a row this build guaranteed from one it did not.
   *
   * Optional because the pending-event rows share this shape and do not select it. Absent is
   * treated as unknown, which means validated -- the safe direction.
   */
  readonly schema_version?: number;
}

interface CanonicalEvent {
  readonly event: ProtocolEvent;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly inputIndex: number;
}

interface PendingRow {
  readonly event_id: string;
  readonly content_digest: string;
  readonly canonical_event: Uint8Array | string;
  readonly causation_id: string;
}

function storedBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(value);
}

function parseStoredEvent(row: StoredRow): ProtocolEvent {
  try {
    const input: unknown = JSON.parse(new TextDecoder().decode(storedBytes(row.canonical_event)));
    const result = parseEvent(input);
    if (result.value === null) {
      throw new StorageError("STORAGE_CORRUPT_EVENT", "stored event failed protocol validation", {
        eventId: row.event_id,
        diagnostics: JSON.stringify(result.diagnostics),
      });
    }
    return result.value;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("STORAGE_CORRUPT_EVENT", "stored event cannot be reconstructed", {
      eventId: row.event_id,
    });
  }
}

/**
 * The schema versions `parseEvent` knows how to validate.
 *
 * A row stamped with anything else is validated even on an unchecked read: an unknown version
 * is the one case where the write-time guarantee below does not hold, because the writer that
 * made the guarantee was a different build.
 */
const KNOWN_SCHEMA_VERSIONS = new Set([1, 2, 3]);

/**
 * Reconstruct a stored event without re-running schema validation.
 *
 * Every row in `events` was validated by `parseCanonicalEvent` before it was inserted, and
 * SQLite is the only writer. Re-validating on read therefore re-proves a property that was
 * established at write time -- and it is not cheap: measured on this repository's ledger,
 * one 4,617-event window costs 120ms in SQL, 62ms in `JSON.parse`, and **1,100ms in Ajv**.
 * Validation was 86% of the read.
 *
 * This is the same trade the write side already made for the same reason. `packages/recorder`
 * keeps `@patchmesh/protocol` off the hook path because per-call schema compilation costs more
 * than the work it guards, and a test walks the import graph to keep it out. The read path had
 * never had the equivalent, so every advisory MCP answer paid for it.
 *
 * Two things preserve safety. A row whose `schema_version` is not one this build knows is
 * validated anyway, because the write-time guarantee was made by a different build. And this
 * is opt-in: `replay`, `verify` and anything deciding integrity keep the checked path, which
 * is the reason `validate` defaults to true rather than false.
 *
 * Unlike `parseEvent` the result is not deep-frozen. Advisory readers only read, and freezing
 * every event in a window is itself proportional to history.
 */
function reconstructStoredEvent(row: StoredRow): ProtocolEvent {
  try {
    const input: unknown = JSON.parse(new TextDecoder().decode(storedBytes(row.canonical_event)));
    if (row.schema_version === undefined || !KNOWN_SCHEMA_VERSIONS.has(row.schema_version)) {
      return parseStoredEvent(row);
    }
    return input as ProtocolEvent;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("STORAGE_CORRUPT_EVENT", "stored event cannot be reconstructed", {
      eventId: row.event_id,
    });
  }
}

function parseCanonicalEvent(input: unknown, inputIndex: number): CanonicalEvent {
  const parsed = parseEvent(input);
  if (parsed.value === null) throw new ProtocolValidationError(parsed.diagnostics);
  return {
    event: parsed.value,
    bytes: canonicalBytes(parsed.value),
    digest: canonicalDigest(parsed.value),
    inputIndex,
  };
}

export class SqliteEventStore {
  private closed = false;

  private constructor(private readonly database: DatabaseSync) {}

  static open(filename: string): SqliteEventStore {
    return new SqliteEventStore(openDatabase(filename));
  }

  append(input: unknown): AppendResult {
    this.assertOpen();
    return this.appendAtomic([input])[0]!;
  }

  appendAtomic(inputs: readonly unknown[], options: AtomicAppendOptions = {}): readonly AppendResult[] {
    this.assertOpen();
    if (inputs.length === 0) return [];

    const candidates = inputs.map((input, inputIndex) => parseCanonicalEvent(input, inputIndex));
    const firstCandidatesById = new Map<EventId, CanonicalEvent>();
    for (const candidate of candidates) {
      const first = firstCandidatesById.get(candidate.event.eventId);
      if (first === undefined) {
        firstCandidatesById.set(candidate.event.eventId, candidate);
        continue;
      }
      if (first.digest !== candidate.digest) {
        throw new StorageError("PHASE0_ID_CONFLICT", "event ID has conflicting content", {
          eventId: candidate.event.eventId,
        });
      }
    }

    const lookup = this.database.prepare(
      "SELECT event_id, content_digest, canonical_event, schema_version FROM events WHERE event_id = ?",
    );
    const insert = this.database.prepare(`
      INSERT INTO events (
        event_id, content_digest, canonical_event, schema_version, event_type,
        source_kind, source_id, source_instance_id, source_sequence, timestamp,
        repository_id, workspace_id, worktree_id, agent_id, task_id,
        correlation_id, causation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const buffering = options.bufferUnresolvedCausalParents === true;
    let transactionOpen = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const existingEvents = new Map<EventId, ProtocolEvent>();
      const newCandidates: CanonicalEvent[] = [];
      for (const candidate of firstCandidatesById.values()) {
        const existing = lookup.get(candidate.event.eventId) as StoredRow | undefined;
        if (existing === undefined) {
          newCandidates.push(candidate);
          continue;
        }
        if (existing.content_digest !== candidate.digest) {
          throw new StorageError("PHASE0_ID_CONFLICT", "event ID has conflicting content", {
            eventId: candidate.event.eventId,
          });
        }
        existingEvents.set(candidate.event.eventId, parseStoredEvent(existing));
      }

      // Without buffering every new candidate is admitted directly, preserving the
      // pre-existing tolerance for an out-of-order child (invariant 4).
      const admitted: CanonicalEvent[] = [];
      const deferred: CanonicalEvent[] = [];
      const promoted: PendingRow[] = [];
      /** Buffered rows made redundant because the same event was admitted from the input. */
      const supersededPendingIds = new Set<EventId>();
      if (!buffering) {
        admitted.push(...newCandidates);
      } else {
        const durableIds = new Set(this.durableEventIds());
        const resolved = new Set(durableIds);
        // A candidate is admissible when its parent is already durable or is itself an
        // admissible candidate in this batch. Iterating to a fixpoint admits a whole
        // chain that arrived in reverse order within one call.
        let changed = true;
        const undecided = [...newCandidates];
        while (changed) {
          changed = false;
          for (let index = undecided.length - 1; index >= 0; index -= 1) {
            const candidate = undecided[index]!;
            const parent = candidate.event.causationId;
            if (parent !== null && !resolved.has(parent)) continue;
            resolved.add(candidate.event.eventId);
            admitted.push(candidate);
            undecided.splice(index, 1);
            changed = true;
          }
        }
        deferred.push(...undecided);

        // Anything already buffered whose parent is now resolved joins the durable log.
        // Promotion cascades, because a promoted event can unblock its own children.
        //
        // A resubmitted event must be excluded whichever side it landed on. Deferred was
        // always excluded, but an event buffered earlier and resubmitted alongside the parent
        // that unblocks it is ADMITTED from the input while its pending row still qualifies
        // for promotion - inserting the same event_id twice in one transaction, which the
        // uniqueness constraint rejects and which rolls back the whole batch.
        const deferredIds = new Set<EventId>(deferred.map((candidate) => candidate.event.eventId));
        const resubmittedIds = new Set<EventId>([
          ...deferredIds,
          ...admitted.map((candidate) => candidate.event.eventId),
        ]);
        const allPendingRows = this.pendingRows();
        // An admitted candidate that also has a buffered row is the same event arriving by a
        // second route. It is inserted once, from the input, and its now-redundant buffered
        // row is retired in the same transaction so the two tables cannot disagree.
        for (const row of allPendingRows) {
          const eventId = row.event_id as EventId;
          if (resubmittedIds.has(eventId) && !deferredIds.has(eventId)) supersededPendingIds.add(eventId);
        }
        const pendingRows = allPendingRows.filter((row) => !resubmittedIds.has(row.event_id as EventId));
        let promotedAny = true;
        while (promotedAny) {
          promotedAny = false;
          for (let index = pendingRows.length - 1; index >= 0; index -= 1) {
            const row = pendingRows[index]!;
            if (!resolved.has(row.causation_id as EventId)) continue;
            resolved.add(row.event_id as EventId);
            promoted.push(row);
            pendingRows.splice(index, 1);
            promotedAny = true;
          }
        }
      }

      if (options.requireValidEventSet === true) {
        const diagnostics = validateEventSet([
          ...this.read(),
          ...admitted.map((candidate) => candidate.event),
          ...promoted.map((row) => parseStoredEvent(row)),
        ]);
        if (diagnostics.length > 0) throw new ProtocolValidationError(diagnostics);
      }

      for (const candidate of admitted) this.insertEvent(insert, candidate.event, candidate.digest, candidate.bytes);
      for (const row of promoted) {
        this.insertEvent(insert, parseStoredEvent(row), row.content_digest, storedBytes(row.canonical_event));
      }
      if (promoted.length > 0 || supersededPendingIds.size > 0) {
        const remove = this.database.prepare("DELETE FROM pending_events WHERE event_id = ?");
        for (const row of promoted) remove.run(row.event_id);
        for (const eventId of supersededPendingIds) remove.run(eventId);
      }
      if (deferred.length > 0) {
        const buffer = this.database.prepare(`
          INSERT INTO pending_events (event_id, content_digest, canonical_event, causation_id, buffered_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (event_id) DO NOTHING
        `);
        const bufferedAt = new Date().toISOString();
        for (const candidate of deferred) {
          const pending = this.pendingRow(candidate.event.eventId);
          if (pending !== undefined && pending.content_digest !== candidate.digest) {
            throw new StorageError("PHASE0_ID_CONFLICT", "event ID has conflicting content", {
              eventId: candidate.event.eventId,
            });
          }
          buffer.run(
            candidate.event.eventId,
            candidate.digest,
            Buffer.from(candidate.bytes),
            candidate.event.causationId,
            bufferedAt,
          );
        }
      }
      this.database.exec("COMMIT");
      transactionOpen = false;

      const deferredIds = new Set(deferred.map((candidate) => candidate.event.eventId));
      return candidates.map((candidate) => {
        const existing = existingEvents.get(candidate.event.eventId);
        if (existing !== undefined) return { status: "duplicate", event: existing };
        const first = firstCandidatesById.get(candidate.event.eventId)!;
        if (deferredIds.has(first.event.eventId)) return { status: "buffered", event: first.event };
        return candidate.inputIndex === first.inputIndex
          ? { status: "inserted", event: first.event }
          : { status: "duplicate", event: first.event };
      });
    } catch (error) {
      if (transactionOpen) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // SQLite already rolled the transaction back itself (RAISE(ROLLBACK), SQLITE_FULL,
          // SQLITE_IOERR, a failed COMMIT). The explicit ROLLBACK then fails, and its error
          // MUST NOT displace the failure the caller needs to diagnose.
        }
      }
      throw error;
    }
  }

  /**
   * Events held by append-time buffering because their causal parent is not durable,
   * in arrival order. These are deliberately excluded from `read` and `replay`: they
   * are not yet part of the log, and a parent that never arrives leaves them here
   * rather than making replay unresolvable.
   */
  readPending(): readonly ProtocolEvent[] {
    this.assertOpen();
    return this.pendingRows().map((row) => parseStoredEvent(row));
  }

  private pendingRows(): readonly PendingRow[] {
    return this.database.prepare(`
      SELECT event_id, content_digest, canonical_event, causation_id
      FROM pending_events
      ORDER BY buffered_position ASC
    `).all() as unknown as PendingRow[];
  }

  private pendingRow(eventId: EventId): PendingRow | undefined {
    return this.database.prepare(`
      SELECT event_id, content_digest, canonical_event, causation_id
      FROM pending_events WHERE event_id = ?
    `).get(eventId) as PendingRow | undefined;
  }

  private durableEventIds(): readonly EventId[] {
    const rows = this.database.prepare("SELECT event_id FROM events").all() as Array<{ readonly event_id: string }>;
    return rows.map((row) => row.event_id as EventId);
  }

  private insertEvent(
    insert: ReturnType<DatabaseSync["prepare"]>,
    event: ProtocolEvent,
    digest: string,
    bytes: Uint8Array,
  ): void {
    insert.run(
      event.eventId,
      digest,
      Buffer.from(bytes),
      event.schemaVersion,
      event.eventType,
      event.source.kind,
      event.source.sourceId,
      event.source.instanceId,
      event.sourceSequence,
      event.timestamp,
      event.repositoryId,
      event.workspaceId,
      event.worktreeId,
      event.agentId,
      event.taskId,
      event.correlationId,
      event.causationId,
    );
  }

  read(query: EventQuery = {}, options: ReadOptions = {}): readonly ProtocolEvent[] {
    this.assertOpen();
    const predicates: string[] = [];
    const parameters: Array<string | number> = [];

    if (query.eventId !== undefined) {
      predicates.push("event_id = ?");
      parameters.push(query.eventId);
    }
    if (query.eventType !== undefined) {
      predicates.push("event_type = ?");
      parameters.push(query.eventType);
    }
    if (query.eventTypes !== undefined) {
      // An empty set asks for nothing, which is a real answer and must not read everything.
      predicates.push(`event_type IN (${query.eventTypes.map(() => "?").join(", ") || "NULL"})`);
      parameters.push(...query.eventTypes);
    }
    if (query.since !== undefined) {
      predicates.push("timestamp >= ?");
      parameters.push(query.since);
    }
    if (query.correlationId !== undefined) {
      predicates.push("correlation_id = ?");
      parameters.push(query.correlationId);
    }
    if (query.causationId !== undefined) {
      predicates.push(query.causationId === null ? "causation_id IS NULL" : "causation_id = ?");
      if (query.causationId !== null) parameters.push(query.causationId);
    }

    const where = predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`;
    const rows = this.database.prepare(`
      SELECT event_id, content_digest, canonical_event, schema_version
      FROM events${where}
      ORDER BY insertion_position ASC
    `).all(...parameters) as unknown as StoredRow[];
    return rows.map(options.validate === false ? reconstructStoredEvent : parseStoredEvent);
  }

  replay(): ReplayResult<readonly ProtocolEvent[]>;
  replay<State>(reducer: ReplayReducer<State>): ReplayResult<State>;
  replay<State>(reducer?: ReplayReducer<State>): ReplayResult<State | readonly ProtocolEvent[]> {
    this.assertOpen();
    const events = this.read();
    return reducer ? replayEvents(events, reducer) : replayEvents(events);
  }


  /**
   * Delete events older than a cutoff, without breaking causal replay.
   *
   * A ledger is append-only and nothing pruned it, so it grew without bound - this repository
   * reached 1.9MB in four days of one developer, and the value of a recorded call decays fast
   * (recall looks back four hours by default, recap one day). Retention is therefore a real
   * operation rather than a nicety.
   *
   * The hazard is that deleting a time prefix can strand a survivor's `causationId`, and replay
   * fails closed on a dangling reference - so a careless prune would turn a large ledger into an
   * unreadable one. Anything a survivor still points at is retained, transitively: the recursive
   * term follows each protected event's own parent, because protecting A while deleting the
   * event A points at just moves the dangling reference one link back.
   *
   * Buffered events past the cutoff are dropped outright. They are waiting for a causal parent
   * that is now, by construction, never arriving.
   */
  prune(options: { readonly olderThan: Date }): PruneResult {
    this.assertOpen();
    const cutoff = options.olderThan.toISOString();
    const before = this.count();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        WITH RECURSIVE protected(id) AS (
          SELECT causation_id FROM events
          WHERE causation_id IS NOT NULL AND timestamp >= ?
          UNION
          SELECT parent.causation_id FROM events parent
          JOIN protected ON parent.event_id = protected.id
          WHERE parent.causation_id IS NOT NULL
        )
        DELETE FROM events
        WHERE timestamp < ? AND event_id NOT IN (SELECT id FROM protected)
      `).run(cutoff, cutoff);
      this.database.prepare("DELETE FROM pending_events WHERE event_id IN (SELECT event_id FROM pending_events)").run();
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // SQLite may have rolled back already; the originating error is the one that matters.
      }
      throw error;
    }

    const retained = this.count();
    return { removed: before - retained, retained };
  }

  /** How many events the store holds. Counted in SQLite rather than by loading them. */
  count(): number {
    this.assertOpen();
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM events").get() as { readonly total: number };
    return row.total;
  }

  /**
   * The most recent event's timestamp, or null when the store is empty.
   *
   * The companion to `count()`, and it exists for the same caller: `doctor` wants to say how
   * many events there are and how recent they are, and was loading, parsing and validating
   * every one of them to learn two numbers. Served by the `events(timestamp)` index that
   * migration 003 already added for the recall window.
   */
  latestTimestamp(): string | null {
    this.assertOpen();
    const row = this.database.prepare("SELECT MAX(timestamp) AS latest FROM events").get() as
      { readonly latest: string | null };
    return row.latest;
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new StorageError("STORAGE_CLOSED", "PatchMesh event store is closed");
  }
}
