import { createHash } from "node:crypto";

import type {
  DependencyChangedEvent,
  DependencyId,
  EventId,
} from "patchmesh-protocol";

import type { ConsumerImportFact, SymbolEvidenceFact } from "./evidence-facts.js";
import type { SymbolEventContext } from "./symbol-events.js";

export interface ResolvedContractDependency {
  readonly consumer: ConsumerImportFact;
  readonly contract: SymbolEvidenceFact;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dependencyId(value: ResolvedContractDependency): DependencyId {
  return `dep_${digest(JSON.stringify({
    consumer: value.consumer.consumer.resourceId,
    consumerVersion: value.consumer.consumerVersion,
    contract: value.contract.resource.resourceId,
    contractVersion: value.contract.version,
    importedNames: value.consumer.importedNames,
  })).slice(0, 32)}` as DependencyId;
}

function causalParent(value: ResolvedContractDependency): EventId {
  const eventId = value.consumer.sourceFacts.sourceEventIds[0];
  if (eventId === undefined) throw new Error("dependency evidence requires a consumer source event ID");
  return eventId;
}

/**
 * Produces a dependency event only after a resolver has associated a parsed import
 * with a specific exported contract. Unsupported, ambiguous, and unresolved imports
 * deliberately have no candidate event and remain degraded source coverage.
 */
export function deriveDependencyChangedEvents(
  dependencies: readonly ResolvedContractDependency[],
  eventIds: readonly EventId[],
  context: SymbolEventContext,
): readonly DependencyChangedEvent[] {
  if (dependencies.length !== eventIds.length) {
    throw new Error("one event ID is required for each resolved contract dependency");
  }
  return dependencies.map((entry, index) => ({
    schemaVersion: 1,
    eventId: eventIds[index]!,
    eventType: "dependency.changed",
    source: context.source,
    timestamp: context.timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: context.agentId,
    taskId: context.taskId,
    correlationId: context.correlationId,
    causationId: causalParent(entry),
    sourceSequence: context.sourceSequenceStart === null ? null : context.sourceSequenceStart + index,
    payload: {
      dependency: {
        dependencyId: dependencyId(entry),
        dependentResourceId: entry.consumer.consumer.resourceId,
        dependencyResourceId: entry.contract.resource.resourceId,
        dependentVersion: entry.consumer.consumerVersion,
        dependencyVersion: entry.contract.version,
        observations: [{
          kind: "statically_observed",
          producer: {
            sourceId: context.source.sourceId,
            version: entry.consumer.sourceFacts.analyzer.version,
          },
          rule: null,
          evidenceEventIds: entry.consumer.sourceFacts.sourceEventIds,
        }],
        evidenceEventIds: [...new Set([
          ...entry.consumer.sourceFacts.sourceEventIds,
          ...entry.contract.sourceFacts.sourceEventIds,
        ])].sort((left, right) => left.localeCompare(right)),
      },
    },
  }));
}
