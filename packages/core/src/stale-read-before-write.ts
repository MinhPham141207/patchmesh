import type {
  CoverageId,
  DependencyId,
  EventId,
  ResourceId,
  ResourceVersion,
  TaskId,
  TargetSnapshot,
} from "patchmesh-protocol";

import type { DetectorFinding } from "./types.js";

export interface ResourceReadEvidence {
  readonly eventId: EventId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly version: ResourceVersion;
  readonly coverageId: CoverageId;
  readonly targetSnapshot: TargetSnapshot;
}

export interface DependentWriteEvidence {
  readonly eventId: EventId;
  readonly dependencyId: DependencyId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly dependsOnReadEventId: EventId;
  readonly coverageId: CoverageId;
  readonly comparisonChangedEventId?: EventId;
  readonly comparisonCoverageId?: CoverageId;
  readonly targetSnapshot: TargetSnapshot;
  readonly readTokenDigest: string;
  readonly writeEffectEventId: EventId;
  readonly writeEffectCoverageId: CoverageId;
  readonly completionEventId: EventId;
}

export interface CurrentVersionEvidence extends ResourceVersion {
  readonly eventId?: EventId;
}

function hasSameRepositoryWorkspace(left: ResourceVersion, right: ResourceVersion): boolean {
  return left.domain.repositoryId === right.domain.repositoryId
    && left.domain.workspaceId === right.domain.workspaceId;
}

/**
 * Reports only a confirmed stale dependency: the write explicitly depends on
 * the task's immutable read and a later observed version differs from it.
 */
export function detectStaleReadBeforeWrite(
  read: ResourceReadEvidence,
  current: CurrentVersionEvidence,
  write: DependentWriteEvidence,
): DetectorFinding | null {
  if (read.version.value === null
    || current.value === null
    || read.resourceId !== current.resourceId
    || read.taskId !== write.taskId
    || write.dependsOnReadEventId !== read.eventId
    || write.comparisonChangedEventId !== current.eventId
    || write.comparisonCoverageId === undefined
    || read.targetSnapshot.targetSnapshotId !== write.targetSnapshot.targetSnapshotId
    || read.targetSnapshot.digest !== write.targetSnapshot.digest
    || !hasSameRepositoryWorkspace(read.version, current)
    || read.version.kind !== current.kind
    || read.version.value === current.value) {
    return null;
  }

  const evidenceEventIds = [
    read.eventId,
    write.eventId,
    ...current.evidenceEventIds,
  ].sort((left, right) => left.localeCompare(right));
  const coverageIds = [...new Set([read.coverageId, write.coverageId, write.comparisonCoverageId, write.writeEffectCoverageId])]
    .sort((left, right) => left.localeCompare(right));

  return {
    findingType: "stale_read_before_write",
    evidence: {
      subjectResourceId: read.resourceId,
      affectedTaskId: write.taskId,
      dependencyIds: [write.dependencyId],
      evidenceEventIds,
      coverageIds,
    },
    confidence: 0.95,
    reason: `Write ${write.eventId} depends on ${read.eventId}, which observed ${read.version.value} before ${current.value}.`,
  };
}
