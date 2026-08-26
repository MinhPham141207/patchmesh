import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventId } from "patchmesh-protocol";
import type { SourceSequenceGap } from "./replay.js";
import type {
  AttributionOverride,
  DecisionView,
  FindingView,
  GraphEdge,
  GraphNode,
  WorkGraphState,
} from "./work-graph-types.js";

/**
 * Bump whenever projection output could change for identical input: detector logic,
 * coverage derivation, evidence merging, view shapes. A stored version that differs from
 * this constant is treated as no checkpoint at all, never as an error.
 */
export const PROJECTOR_VERSION = "1";

export interface ProjectionCheckpointRecord {
  readonly projectorVersion: string;
  readonly lastInsertionPosition: number;
  readonly gaps: SourceSequenceGap[];
  readonly coverageForSnapshot: WorkGraphState["coverageInputs"];
  readonly correctionsByTarget: Array<[EventId, AttributionOverride]>;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly findings: FindingView[];
  readonly decisions: DecisionView[];
}

interface StoredRow {
  readonly projector_version: string;
  readonly last_insertion_position: number;
  readonly state_hash: string;
  readonly state_blob: string;
}

function serializeRecord(record: ProjectionCheckpointRecord): string {
  return JSON.stringify(record);
}

export function checkpointRecordHash(record: ProjectionCheckpointRecord): string {
  return createHash("sha256").update(serializeRecord(record)).digest("hex");
}

export function loadProjectionCheckpoint(database: DatabaseSync): ProjectionCheckpointRecord | null {
  const rows = database
    .prepare(
      "SELECT projector_version, last_insertion_position, state_hash, state_blob FROM projection_checkpoint WHERE id = 0",
    )
    .all() as unknown as StoredRow[];
  const row = rows[0];
  if (row === undefined) return null;
  let parsed: ProjectionCheckpointRecord;
  try {
    parsed = JSON.parse(row.state_blob) as ProjectionCheckpointRecord;
  } catch {
    return null;
  }
  if (checkpointRecordHash(parsed) !== row.state_hash) return null;
  return parsed;
}

export function saveProjectionCheckpoint(database: DatabaseSync, record: ProjectionCheckpointRecord): void {
  const blob = serializeRecord(record);
  const hash = checkpointRecordHash(record);
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO projection_checkpoint (id, projector_version, last_insertion_position, state_hash, state_blob)
         VALUES (0, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           projector_version = excluded.projector_version,
           last_insertion_position = excluded.last_insertion_position,
           state_hash = excluded.state_hash,
           state_blob = excluded.state_blob`,
      )
      .run(record.projectorVersion, record.lastInsertionPosition, hash, blob);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function clearProjectionCheckpoint(database: DatabaseSync): void {
  database.prepare("DELETE FROM projection_checkpoint WHERE id = 0").run();
}
