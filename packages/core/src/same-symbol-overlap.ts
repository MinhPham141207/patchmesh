import type {
  AgentId,
  CoverageId,
  EventId,
  ResourceId,
  ResourceVersion,
  TaskId,
  TargetSnapshot,
  WorktreeId,
} from "@patchmesh/protocol";

import type { DetectorFinding } from "./types.js";

/**
 * A normalized, symbol-scoped change supplied by the evidence pipeline.
 * File-level changes must not be coerced into this shape.
 */
export interface SymbolChangeEvidence {
  readonly eventId: EventId;
  readonly resourceId: ResourceId;
  readonly version: ResourceVersion;
  readonly agentId: AgentId | null;
  readonly taskId: TaskId | null;
  readonly worktreeId: WorktreeId;
  readonly coverageId: CoverageId;
  /** Coverage proving the shared concurrency observation. */
  readonly concurrencyCoverageId?: CoverageId;
  readonly targetSnapshot?: TargetSnapshot;
  readonly concurrencyEventId?: EventId;
}

function hasComparableIdentity(evidence: SymbolChangeEvidence): boolean {
  return evidence.agentId !== null
    && evidence.taskId !== null
    && evidence.version.value !== null;
}

function hasSameRepository(
  left: ResourceVersion,
  right: ResourceVersion,
): boolean {
  return left.domain.repositoryId === right.domain.repositoryId
    && left.resourceId === right.resourceId;
}

/**
 * Produces an advisory finding only for independently attributed edits to the
 * same symbol at different, fully identified versions. Shared reads and
 * incomplete/file-only evidence deliberately produce no finding here.
 */
export function detectSameSymbolOverlap(
  observed: SymbolChangeEvidence,
  candidate: SymbolChangeEvidence,
): DetectorFinding | null {
  if (!hasComparableIdentity(observed) || !hasComparableIdentity(candidate)) {
    return null;
  }

  if (observed.resourceId !== candidate.resourceId
    || observed.taskId === candidate.taskId
    || observed.worktreeId === candidate.worktreeId
    || observed.targetSnapshot === undefined
    || candidate.targetSnapshot === undefined
    || observed.targetSnapshot.targetSnapshotId !== candidate.targetSnapshot.targetSnapshotId
    || observed.targetSnapshot.digest !== candidate.targetSnapshot.digest
    || observed.concurrencyEventId === undefined
    || candidate.concurrencyEventId !== observed.concurrencyEventId
    || observed.concurrencyCoverageId === undefined
    || candidate.concurrencyCoverageId !== observed.concurrencyCoverageId
    || !hasSameRepository(observed.version, candidate.version)
    || observed.version.kind !== candidate.version.kind
    || observed.version.value === candidate.version.value) {
    return null;
  }

  const evidenceEventIds = [observed.eventId, candidate.eventId, observed.concurrencyEventId]
    .sort((left, right) => left.localeCompare(right));
  const coverageIds = [...new Set([observed.coverageId, candidate.coverageId, observed.concurrencyCoverageId])]
    .sort((left, right) => left.localeCompare(right));

  return {
    findingType: "same_symbol_overlap",
    evidence: {
      subjectResourceId: candidate.resourceId,
      affectedTaskId: candidate.taskId,
      dependencyIds: [],
      evidenceEventIds,
      coverageIds,
    },
    confidence: 0.9,
    reason: `Independent tasks changed ${candidate.resourceId} at ${observed.version.value} and ${candidate.version.value}.`,
  };
}
