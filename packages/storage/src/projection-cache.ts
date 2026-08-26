import type { DatabaseSync } from "node:sqlite";
import type { EventId, ProtocolEvent } from "patchmesh-protocol";
import { SqliteEventStore } from "./event-store.js";
import {
  loadProjectionCheckpoint,
  saveProjectionCheckpoint,
  PROJECTOR_VERSION,
  type ProjectionCheckpointRecord,
} from "./projection-checkpoint.js";
import { causalOrder, sourceSequenceGaps, type SourceSequenceGap } from "./replay.js";
import { extendProjection, projectWorkGraph, snapshotFromState } from "./work-graph.js";
import { deriveProjectionCoverage } from "./work-graph-coverage.js";
import type { WorkGraphReplayResult, WorkGraphState } from "./work-graph-types.js";

const stats = { fullRebuilds: 0, deltaApplications: 0, zeroDeltaServes: 0, lastAppliedCount: 0 };

export function projectionCacheStats() {
  return { ...stats };
}

export function clearProjectionCacheStats(): void {
  stats.fullRebuilds = 0;
  stats.deltaApplications = 0;
  stats.zeroDeltaServes = 0;
  stats.lastAppliedCount = 0;
}

function recordFromState(state: WorkGraphState, lastInsertionPosition: number, gaps: readonly SourceSequenceGap[]): ProjectionCheckpointRecord {
  return {
    projectorVersion: PROJECTOR_VERSION,
    lastInsertionPosition,
    gaps: structuredClone(gaps) as SourceSequenceGap[],
    // Coverage already gap-applied, so the zero-delta serve can use it with gaps = []:
    coverageForSnapshot: structuredClone(
      gaps.length === 0
        ? state.coverageInputs
        : deriveProjectionCoverage([...state.eventsById.values()], gaps, state.correctionsByTarget),
    ),
    correctionsByTarget: [...state.correctionsByTarget.entries()],
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
    findings: [...state.findings.values()],
    decisions: [...state.decisions.values()],
  };
}

function stateFromRecord(record: ProjectionCheckpointRecord, eventsById: Map<EventId, ProtocolEvent> = new Map()): WorkGraphState {
  return {
    eventsById,
    correctionsByTarget: new Map(record.correctionsByTarget),
    nodes: new Map(record.nodes.map((node) => [node.nodeId, node])),
    edges: new Map(record.edges.map((edge) => [edge.edgeId, edge])),
    findings: new Map(record.findings.map((view) => [view.finding.findingId, view])),
    decisions: new Map(record.decisions.map((view) => [view.decision.decisionId, view])),
    coverageInputs: record.coverageForSnapshot,
  };
}

/**
 * The watermarked row must still exist. Pruning deletes a time prefix without touching
 * positions after it, so a max-position comparison alone would keep serving a checkpoint
 * whose history is gone; this closes that hole.
 */
function databaseHasPosition(database: DatabaseSync, position: number): boolean {
  const row = database.prepare("SELECT 1 FROM events WHERE insertion_position = ?").get(position);
  return row !== undefined;
}

/**
 * The watermark a persist may store: the highest insertion_position among the rows this read
 * actually applied. Reading it from the rows rather than from `latestPosition()` keeps a
 * concurrent append that lands after the reads from being watermarked before it is applied —
 * an ahead-watermark makes the next read serve zero delta while permanently omitting those
 * events. A behind-watermark is harmless: re-application is idempotent per event id.
 */
export function maxAppliedPosition(
  handle: DatabaseSync,
  minExclusive: number,
  appliedIds: ReadonlySet<string>,
): number {
  const rows = handle
    .prepare("SELECT event_id, insertion_position FROM events WHERE insertion_position > ?")
    .all(minExclusive) as unknown as Array<{ readonly event_id: string; readonly insertion_position: number }>;
  let watermark = minExclusive;
  for (const row of rows) {
    if (appliedIds.has(row.event_id) && row.insertion_position > watermark) watermark = row.insertion_position;
  }
  return watermark;
}

function persistQuietly(store: SqliteEventStore, record: ProjectionCheckpointRecord): void {
  try {
    saveProjectionCheckpoint(store.handle, record);
  } catch {
    // A reader that could not write the checkpoint still answered correctly; the next
    // reader pays the delta again. Never let checkpoint maintenance break a read.
  }
}

export function projectWorkGraphCached(
  ledgerPath: string,
  options: { readonly verify?: boolean } = {},
): WorkGraphReplayResult {
  const store = SqliteEventStore.open(ledgerPath);
  try {
    if (options.verify === true) {
      const events = store.read();
      const result = projectWorkGraph(events);
      stats.lastAppliedCount = events.length;
      persistQuietly(store, recordFromState(result.state, maxAppliedPosition(store.handle, 0, new Set(events.map((event) => event.eventId))), result.sourceSequenceGaps));
      return result;
    }

    const checkpoint = loadProjectionCheckpoint(store.handle);
    const valid =
      checkpoint !== null &&
      checkpoint.projectorVersion === PROJECTOR_VERSION &&
      checkpoint.lastInsertionPosition <= store.latestPosition() &&
      databaseHasPosition(store.handle, checkpoint.lastInsertionPosition);
    if (!valid || checkpoint === null) {
      stats.fullRebuilds += 1;
      const events = store.read();
      const result = projectWorkGraph(events);
      stats.lastAppliedCount = events.length;
      persistQuietly(store, recordFromState(result.state, maxAppliedPosition(store.handle, 0, new Set(events.map((event) => event.eventId))), result.sourceSequenceGaps));
      return result;
    }

    const fresh = store.read({ afterPosition: checkpoint.lastInsertionPosition });
    if (fresh.length === 0) {
      stats.zeroDeltaServes += 1;
      stats.lastAppliedCount = 0;
      const state = stateFromRecord(checkpoint);
      return {
        orderedEvents: Object.freeze([]),
        sourceSequenceGaps: checkpoint.gaps,
        state,
        snapshot: snapshotFromState(state, []),
      };
    }

    stats.deltaApplications += 1;
    stats.lastAppliedCount = fresh.length;
    // History is trusted (hash-checked checkpoint); the delta was validated by `fresh`'s
    // checked read above, so the whole-ledger ordering can skip re-validation.
    const reconstructed = store.read({}, { validate: false });
    const ordered = causalOrder(reconstructed);
    const gaps = sourceSequenceGaps(ordered);
    const base = stateFromRecord(checkpoint, new Map(ordered.map((event) => [event.eventId, event])));
    const extended = extendProjection(base, fresh);
    if (extended === null) {
      // A late correction reached back into history; rebuild rather than serve stale mapping.
      stats.fullRebuilds += 1;
      const events = store.read();
      const result = projectWorkGraph(events);
      stats.lastAppliedCount = events.length;
      persistQuietly(store, recordFromState(result.state, maxAppliedPosition(store.handle, 0, new Set(events.map((event) => event.eventId))), result.sourceSequenceGaps));
      return result;
    }
    // The watermark comes from the rows just applied, not from `latestPosition()`: an append
    // landing between the fresh read and this persist must stay unwatermarked until a later
    // read applies it. Re-application overlap is harmless (idempotent per event id); an
    // ahead-watermark would zero-delta-serve while permanently omitting real events.
    persistQuietly(store, recordFromState(extended, maxAppliedPosition(store.handle, checkpoint.lastInsertionPosition, new Set(fresh.map((event) => event.eventId))), gaps));
    return {
      orderedEvents: ordered,
      sourceSequenceGaps: gaps,
      state: extended,
      snapshot: snapshotFromState(extended, gaps),
    };
  } finally {
    store.close();
  }
}
