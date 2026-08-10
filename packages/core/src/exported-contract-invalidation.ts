import type {
  CoverageId,
  DependencyId,
  EventId,
  ResourceId,
  ResourceVersion,
  TaskId,
} from "@patchmesh/protocol";

import type { DetectorFinding } from "./types.js";

export interface ExportedContractChangeEvidence {
  readonly eventId: EventId;
  readonly contractResourceId: ResourceId;
  readonly beforeVersion: ResourceVersion;
  readonly afterVersion: ResourceVersion;
  readonly breaking: boolean;
  readonly coverageId: CoverageId;
  readonly integrationTarget: string;
}

export interface ConsumerContractDependencyEvidence {
  readonly eventId: EventId;
  readonly dependencyId: DependencyId;
  readonly contractResourceId: ResourceId;
  readonly consumerResourceId: ResourceId;
  readonly affectedTaskId: TaskId | null;
  readonly observedContractVersion: ResourceVersion;
  readonly coverageId: CoverageId;
  readonly integrationTarget: string;
}

export function groupConsumersByContract(
  consumers: readonly ConsumerContractDependencyEvidence[],
): ReadonlyMap<ResourceId, readonly ConsumerContractDependencyEvidence[]> {
  const grouped = new Map<ResourceId, ConsumerContractDependencyEvidence[]>();
  for (const consumer of consumers) {
    const entries = grouped.get(consumer.contractResourceId) ?? [];
    entries.push(consumer);
    grouped.set(consumer.contractResourceId, entries);
  }
  return new Map([...grouped.entries()].map(([resourceId, entries]) => [
    resourceId,
    [...entries].sort((left, right) => left.eventId.localeCompare(right.eventId)),
  ]));
}

function matchesVersion(left: ResourceVersion, right: ResourceVersion): boolean {
  return left.resourceId === right.resourceId
    && left.domain.repositoryId === right.domain.repositoryId
    && left.domain.workspaceId === right.domain.workspaceId
    && left.kind === right.kind
    && left.value !== null
    && left.value === right.value;
}

/**
 * Reports a known consumer that observed a contract version invalidated by an
 * explicitly classified breaking change. Inferred imports never enter here.
 */
export function detectExportedContractInvalidation(
  change: ExportedContractChangeEvidence,
  consumer: ConsumerContractDependencyEvidence,
): DetectorFinding | null {
  if (!change.breaking
    || change.contractResourceId !== consumer.contractResourceId
    || change.integrationTarget !== consumer.integrationTarget
    || change.beforeVersion.value === null
    || matchesVersion(change.beforeVersion, change.afterVersion)
    || !matchesVersion(change.beforeVersion, consumer.observedContractVersion)) {
    return null;
  }

  const evidenceEventIds = [
    change.eventId,
    consumer.eventId,
    ...change.afterVersion.evidenceEventIds,
  ].sort((left, right) => left.localeCompare(right));
  const coverageIds = [change.coverageId, consumer.coverageId]
    .sort((left, right) => left.localeCompare(right));

  return {
    findingType: "exported_contract_invalidation",
    evidence: {
      subjectResourceId: change.contractResourceId,
      affectedTaskId: consumer.affectedTaskId,
      dependencyIds: [consumer.dependencyId],
      evidenceEventIds,
      coverageIds,
    },
    confidence: 0.95,
    reason: `Breaking contract change ${change.eventId} invalidates ${consumer.consumerResourceId}'s observed version ${change.beforeVersion.value}.`,
  };
}
