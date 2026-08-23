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

/**
 * STRUCTURALLY UNREACHABLE from hook-recorded traffic. This is not unimplemented work.
 *
 * `detectStaleReadBeforeWrite` requires `DependentWriteEvidence` carrying
 * `dependsOnReadEventId` and a `readTokenDigest` -- a write that explicitly declares which
 * read it depended on. That contract was designed for the proxied `McpProxy` path, which has
 * an authority model and can demand the declaration. Claude Code's hooks declare no such
 * dependency, and deriving one would be exactly the requested-path inference M7 bans.
 *
 * The second blocker is independent and permanent: reads leave no trace. The write half of
 * this problem was solved by observing the filesystem, but a write leaves a difference on
 * disk and a read leaves nothing at all. Measured on a live ledger: 4 `read_file` calls
 * carried a path, against 182 shell commands that read and carried none.
 *
 * So `patchmesh stale` cannot report findings from hook traffic, and no amount of
 * implementation changes that. It correctly declines rather than lying, and it should stop
 * being counted as remaining work. The useful question -- "this file changed after you last
 * touched it" -- is a weaker, time-based reframing that belongs in the `PreToolUse` advisory
 * rather than here. See docs/problems/PM-07.
 *
 * The detector is kept, not deleted: it is correct, it is tested, and it works on the proxied
 * path it was written for.
 */
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
