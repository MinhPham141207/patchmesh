import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import {
  parseEvent,
  ProtocolValidationError,
  type CorrelationId,
  type EventId,
  type EventType,
  type ProtocolEvent,
} from "@patchmesh/protocol";
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
  readonly correlationId?: CorrelationId;
  readonly causationId?: EventId | null;
}

export type AppendResult =
  | { readonly status: "inserted"; readonly event: ProtocolEvent }
  | { readonly status: "duplicate"; readonly event: ProtocolEvent };

export type { ReplayReducer, ReplayResult, SourceSequenceGap } from "./replay.js";

interface StoredRow {
  readonly event_id: string;
  readonly content_digest: string;
  readonly canonical_event: Uint8Array | string;
}

function storedBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(value);
}

function parseStoredEvent(row: StoredRow): ProtocolEvent {
  try {
    const input: unknown = JSON.parse(new TextDecoder().decode(storedBytes(row.canonical_event)));
    const result = parseEvent(input);
    if (result.value === null) throw new Error("stored event failed protocol validation");
    return result.value;
  } catch {
    throw new StorageError("STORAGE_CORRUPT_EVENT", "stored event cannot be reconstructed", {
      eventId: row.event_id,
    });
  }
}

export class SqliteEventStore {
  private closed = false;

  private constructor(private readonly database: DatabaseSync) {}

  static open(filename: string): SqliteEventStore {
    return new SqliteEventStore(openDatabase(filename));
  }

  append(input: unknown): AppendResult {
    this.assertOpen();
    const parsed = parseEvent(input);
    if (parsed.value === null) throw new ProtocolValidationError(parsed.diagnostics);

    const event = parsed.value;
    const bytes = canonicalBytes(event);
    const digest = canonicalDigest(event);
    const lookup = this.database.prepare(
      "SELECT event_id, content_digest, canonical_event FROM events WHERE event_id = ?",
    );
    let transactionOpen = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const existing = lookup.get(event.eventId) as StoredRow | undefined;
      if (existing) {
        if (existing.content_digest !== digest) {
          throw new StorageError("PHASE0_ID_CONFLICT", "event ID has conflicting content", {
            eventId: event.eventId,
          });
        }
        const stored = parseStoredEvent(existing);
        this.database.exec("COMMIT");
        transactionOpen = false;
        return { status: "duplicate", event: stored };
      }

      this.database.prepare(`
        INSERT INTO events (
          event_id, content_digest, canonical_event, schema_version, event_type,
          source_kind, source_id, source_instance_id, source_sequence, timestamp,
          repository_id, workspace_id, worktree_id, agent_id, task_id,
          correlation_id, causation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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
      this.database.exec("COMMIT");
      transactionOpen = false;
      return { status: "inserted", event };
    } catch (error) {
      if (transactionOpen) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  read(query: EventQuery = {}): readonly ProtocolEvent[] {
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
      SELECT event_id, content_digest, canonical_event
      FROM events${where}
      ORDER BY insertion_position ASC
    `).all(...parameters) as unknown as StoredRow[];
    return rows.map(parseStoredEvent);
  }

  replay(): ReplayResult<readonly ProtocolEvent[]>;
  replay<State>(reducer: ReplayReducer<State>): ReplayResult<State>;
  replay<State>(reducer?: ReplayReducer<State>): ReplayResult<State | readonly ProtocolEvent[]> {
    this.assertOpen();
    const events = this.read();
    return reducer ? replayEvents(events, reducer) : replayEvents(events);
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
