import type {
  CoverageId,
  DependencyId,
  EventId,
  ResourceId,
  ResourceVersion,
  TaskId,
} from "@patchmesh/protocol";

import type { DetectorFinding } from "./types.js";

export interface ResourceReadEvidence {
  readonly eventId: EventId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly version: ResourceVersion;
  readonly coverageId: CoverageId;
}

export interface DependentWriteEvidence {
  readonly eventId: EventId;
  readonly dependencyId: DependencyId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly dependsOnReadEventId: EventId;
  readonly coverageId: CoverageId;
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
  current: ResourceVersion,
  write: DependentWriteEvidence,
): DetectorFinding | null {
  if (read.version.value === null
    || current.value === null
    || read.resourceId !== current.resourceId
    || read.taskId !== write.taskId
    || write.dependsOnReadEventId !== read.eventId
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
  const coverageIds = [read.coverageId, write.coverageId]
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
