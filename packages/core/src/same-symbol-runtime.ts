import { createHash } from "node:crypto";
import { classifyContractCompatibility } from "@patchmesh/analyzers";
import type { CoverageId, EventId, ProtocolEvent } from "@patchmesh/protocol";
import type { DerivedEvidenceEvent } from "@patchmesh/protocol";
import { projectWorkGraph } from "@patchmesh/storage";

import { createDurableReportOnlyRecords, type DurableReportOnlyRecords } from "./durable-records.js";
import {
  runExportedContractInvalidationDetector,
  runStaleReadBeforeWriteDetector,
} from "./detector-runner.js";
import { evaluateReportOnlyPolicy } from "./report-only-policy.js";
import { runSameSymbolDetector } from "./detector-runner.js";
import { decisionIdFor, findingIdFor } from "./stable-identities.js";
import type { DetectorFinding } from "./types.js";
import { groupConsumersByContract } from "./exported-contract-invalidation.js";
import type {
  ConsumerContractDependencyEvidence,
  ExportedContractChangeEvidence,
} from "./exported-contract-invalidation.js";
import type { SymbolChangeEvidence } from "./same-symbol-overlap.js";
import type {
  DependentWriteEvidence,
  ResourceReadEvidence,
} from "./stale-read-before-write.js";
import type { CurrentVersionEvidence } from "./stale-read-before-write.js";

const runtimeSource = {
  kind: "core" as const,
  sourceId: "source_phase2",
  instanceId: "00000000-0000-4000-8000-000000000002",
};

function eventId(kind: "finding" | "decision", findingId: string): EventId {
  const digest = createHash("sha256").update(`${kind}:${findingId}`).digest("hex");
  return `evt_${digest.slice(0, 32)}` as EventId;
}

function sufficientCoverageIds(events: readonly ProtocolEvent[]): ReadonlyMap<EventId, CoverageId> {
  let coverage;
  try {
    coverage = projectWorkGraph(events).snapshot.coverage;
  } catch {
    return new Map();
  }
  const matchesByEvent = new Map<EventId, CoverageId[]>();
  for (const entry of coverage.filter((entry) => entry.presentation === "sufficient")) {
    for (const eventId of entry.evidenceEventIds) {
      const matches = matchesByEvent.get(eventId) ?? [];
      matches.push(entry.coverageId);
      matchesByEvent.set(eventId, matches);
    }
  }
  const result = new Map<EventId, CoverageId>();
  for (const [eventId, matches] of matchesByEvent) {
    const unique = [...new Set(matches)].sort((left, right) => left.localeCompare(right));
    if (unique.length === 1) result.set(eventId, unique[0]!);
  }
  return result;
}

function sufficientCoverageId(eventId: EventId, coverageByEvent: ReadonlyMap<EventId, CoverageId>): CoverageId | null {
  return coverageByEvent.get(eventId) ?? null;
}

function sufficientCoverageForEvent(
  event: ProtocolEvent,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
  coverageByEvent: ReadonlyMap<EventId, CoverageId>,
): CoverageId | null {
  const visited = new Set<EventId>();
  let current: ProtocolEvent | undefined = event;
  while (current !== undefined && !visited.has(current.eventId)) {
    visited.add(current.eventId);
    const direct = sufficientCoverageId(current.eventId, coverageByEvent);
    if (direct !== null) return direct;
    current = current.causationId === null ? undefined : eventsById.get(current.causationId);
  }
  return null;
}

function derivedEvidenceByTarget(events: readonly ProtocolEvent[]): ReadonlyMap<EventId, DerivedEvidenceEvent> {
  return new Map(events
    .filter((event): event is DerivedEvidenceEvent => event.eventType === "evidence.derived")
    .map((event) => [event.payload.evidence.targetEventId, event] as const));
}

/**
 * Reconstructs same-symbol evidence from durable events only. It deliberately
 * requires a single sufficient coverage record for each change; ambiguous,
 * file-only, un-attributed, or degraded observations produce no finding.
 */
export function deriveSameSymbolEvidence(events: readonly ProtocolEvent[]): readonly SymbolChangeEvidence[] {
  const coverageByEvent = sufficientCoverageIds(events);
  const eventsById = new Map(events.map((event) => [event.eventId, event] as const));
  const corrections = new Map<EventId, { readonly agentId: ProtocolEvent["agentId"]; readonly taskId: ProtocolEvent["taskId"] }>();
  for (const event of events) {
    if (event.eventType === "attribution.corrected") {
      corrections.set(event.payload.targetEventId, {
        agentId: event.payload.attributedAgentId,
        taskId: event.payload.attributedTaskId,
      });
    }
  }
  const evidence: SymbolChangeEvidence[] = [];
  for (const event of events) {
    if (event.eventType !== "symbol.changed" || event.payload.resource.kind !== "symbol") continue;
    const coverageId = sufficientCoverageForEvent(event, eventsById, coverageByEvent);
    if (coverageId === null) continue;
    const attribution = corrections.get(event.eventId);
    evidence.push({
      eventId: event.eventId,
      resourceId: event.payload.resource.resourceId,
      version: event.payload.afterVersion,
      agentId: attribution?.agentId ?? event.agentId,
      taskId: attribution?.taskId ?? event.taskId,
      worktreeId: event.worktreeId,
      coverageId,
    });
  }
  return evidence.sort((left, right) => left.eventId.localeCompare(right.eventId));
}

/** Reconstructs stale-read inputs from durable V2 writes and causally-covered resource reads. */
export function deriveStaleReadEvidence(events: readonly ProtocolEvent[]): {
  readonly reads: readonly ResourceReadEvidence[];
  readonly currentVersions: readonly CurrentVersionEvidence[];
  readonly writes: readonly DependentWriteEvidence[];
} {
  const coverageByEvent = sufficientCoverageIds(events);
  const eventsById = new Map(events.map((event) => [event.eventId, event] as const));
  const orderedEvents = (() => {
    try {
      return projectWorkGraph(events).orderedEvents;
    } catch {
      return [] as readonly ProtocolEvent[];
    }
  })();
  const eventOrder = new Map(orderedEvents.map((event, index) => [event.eventId, index] as const));
  const reads: ResourceReadEvidence[] = [];
  const writes: DependentWriteEvidence[] = [];
  const currentVersions: CurrentVersionEvidence[] = [];
  for (const event of orderedEvents) {
    const coverageId = sufficientCoverageForEvent(event, eventsById, coverageByEvent);
    if (coverageId === null) continue;
    const order = eventOrder.get(event.eventId);
    if ((event.eventType === "file.read" || event.eventType === "symbol.read") && event.taskId !== null) {
      reads.push({
        eventId: event.eventId,
        ...(order === undefined ? {} : { eventOrder: order }),
        taskId: event.taskId,
        resourceId: event.payload.resource.resourceId,
        version: event.payload.version,
        coverageId,
      });
    }
    if (event.eventType === "write.dependent" && event.taskId !== null) {
      writes.push({
        eventId: event.eventId,
        ...(order === undefined ? {} : { eventOrder: order }),
        dependencyId: event.payload.write.dependencyId,
        taskId: event.taskId,
        resourceId: event.payload.write.resourceId,
        dependsOnReadEventId: event.payload.write.dependsOnReadEventId,
        coverageId,
      });
    }
    if ((event.eventType === "file.changed" || event.eventType === "symbol.changed")
      && event.payload.afterVersion.value !== null) {
      currentVersions.push({
        ...event.payload.afterVersion,
        eventId: event.eventId,
        ...(order === undefined ? {} : { eventOrder: order }),
      });
    }
  }
  return {
    reads: reads.sort((left, right) => left.eventId.localeCompare(right.eventId)),
    currentVersions: currentVersions.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    writes: writes.sort((left, right) => left.eventId.localeCompare(right.eventId)),
  };
}

/**
 * Reconstructs contract invalidation evidence only for a durably-known dependency
 * and an explicit deleted symbol contract. Other signature changes remain unknown
 * until a compatibility classifier is recorded by an analyzer.
 */
export function deriveExportedContractInvalidationEvidence(events: readonly ProtocolEvent[]): {
  readonly changes: readonly ExportedContractChangeEvidence[];
  readonly consumers: readonly ConsumerContractDependencyEvidence[];
} {
  const coverageByEvent = sufficientCoverageIds(events);
  const eventsById = new Map(events.map((event) => [event.eventId, event] as const));
  const derivedByTarget = derivedEvidenceByTarget(events);
  const orderedEvents = (() => {
    try {
      return projectWorkGraph(events).orderedEvents;
    } catch {
      return [] as readonly ProtocolEvent[];
    }
  })();
  const eventOrder = new Map(orderedEvents.map((event, index) => [event.eventId, index] as const));
  const consumers: ConsumerContractDependencyEvidence[] = [];
  for (const event of orderedEvents) {
    if (event.eventType !== "dependency.changed") continue;
    const coverageId = sufficientCoverageForEvent(event, eventsById, coverageByEvent);
    if (coverageId === null) continue;
    const metadata = derivedByTarget.get(event.eventId);
    if (metadata !== undefined && metadata.payload.evidence.factKind !== "dependency") continue;
    consumers.push({
      eventId: event.eventId,
      dependencyId: event.payload.dependency.dependencyId,
      contractResourceId: event.payload.dependency.dependencyResourceId,
      consumerResourceId: event.payload.dependency.dependentResourceId,
      affectedTaskId: event.taskId,
      observedContractVersion: event.payload.dependency.dependencyVersion,
      coverageId,
      ...(metadata === undefined ? {} : { integrationTarget: metadata.payload.evidence.integrationTarget }),
    });
  }
  const consumersByContract = groupConsumersByContract(consumers);
  const changes: ExportedContractChangeEvidence[] = [];
  for (const event of orderedEvents) {
    if (event.eventType !== "symbol.changed" || event.payload.changeKind !== "deleted") continue;
    const coverageId = sufficientCoverageForEvent(event, eventsById, coverageByEvent);
    if (coverageId === null || event.payload.beforeVersion === null) continue;
    if ((consumersByContract.get(event.payload.resource.resourceId)?.length ?? 0) === 0) continue;
    changes.push({
      eventId: event.eventId,
      contractResourceId: event.payload.resource.resourceId,
      beforeVersion: event.payload.beforeVersion,
      afterVersion: event.payload.afterVersion,
      breaking: true,
      coverageId,
    });
  }

  const priorContracts = new Map<string, {
    readonly event: Extract<ProtocolEvent, { readonly eventType: "symbol.changed" }>;
    readonly metadata: DerivedEvidenceEvent;
  }>();
  for (const event of orderedEvents) {
    if (event.eventType !== "symbol.changed") continue;
    const metadata = derivedByTarget.get(event.eventId);
    if (metadata?.payload.evidence.factKind !== "symbol" || metadata.payload.evidence.normalizedSignature === null) continue;
    const key = `${event.repositoryId}:${event.workspaceId}:${metadata.payload.evidence.integrationTarget}:${metadata.payload.evidence.stableFactId}`;
    const previous = priorContracts.get(key);
    if (previous !== undefined && previous.metadata.payload.evidence.normalizedSignature !== null) {
      const coverageId = sufficientCoverageForEvent(event, eventsById, coverageByEvent);
      const compatibility = classifyContractCompatibility(
        previous.metadata.payload.evidence.normalizedSignature,
        metadata.payload.evidence.normalizedSignature,
      );
      if (coverageId !== null && compatibility === "breaking" && event.payload.beforeVersion === null) {
        changes.push({
          eventId: event.eventId,
          contractResourceId: event.payload.resource.resourceId,
          beforeVersion: previous.event.payload.afterVersion,
          afterVersion: event.payload.afterVersion,
          breaking: true,
          coverageId,
          integrationTarget: metadata.payload.evidence.integrationTarget,
        });
      }
    }
    priorContracts.set(key, { event, metadata });
  }
  return {
    changes: changes.sort((left, right) => left.eventId.localeCompare(right.eventId)),
    consumers: consumers.sort((left, right) => left.eventId.localeCompare(right.eventId)),
  };
}

function createRuntimeRecords(
  events: readonly ProtocolEvent[],
  findings: readonly DetectorFinding[],
  detectorId: string,
): readonly DurableReportOnlyRecords[] {
  const eventById = new Map(events.map((event) => [event.eventId, event] as const));
  return findings.map((finding) => {
    const parent = eventById.get(finding.evidence.evidenceEventIds[0]!);
    if (parent === undefined) throw new Error("runtime finding references missing causal evidence");
    const findingId = findingIdFor(finding);
    const policy = evaluateReportOnlyPolicy({ finding, affectedTaskCompleted: false });
    return createDurableReportOnlyRecords(finding, { affectedTaskCompleted: false }, {
      findingId,
      decisionId: decisionIdFor(findingId, policy, finding.evidence.affectedTaskId),
      findingEventId: eventId("finding", findingId),
      decisionEventId: eventId("decision", findingId),
      repositoryId: parent.repositoryId,
      workspaceId: parent.workspaceId,
      worktreeId: parent.worktreeId,
      correlationId: parent.correlationId,
      source: runtimeSource,
      timestamp: parent.timestamp,
      sourceSequenceStart: null,
      detector: { detectorId, version: "1" },
      policy: { policyId: "policy_report-only", version: "1" },
    });
  });
}

/**
 * Creates deterministic, appendable report-only records from replayed,
 * sufficiently-covered symbol changes. Re-running over the same event log yields
 * byte-equivalent records and therefore event-store deduplication.
 */
export function createSameSymbolRuntimeRecords(events: readonly ProtocolEvent[]): readonly DurableReportOnlyRecords[] {
  return createRuntimeRecords(events, runSameSymbolDetector(deriveSameSymbolEvidence(events)), "detector_same-symbol-overlap");
}

/** Runs every replayable Phase 2 detector and creates deterministic report-only records. */
export function createPhase2RuntimeRecords(events: readonly ProtocolEvent[]): readonly DurableReportOnlyRecords[] {
  const stale = deriveStaleReadEvidence(events);
  const contracts = deriveExportedContractInvalidationEvidence(events);
  const records = [
    ...createSameSymbolRuntimeRecords(events),
    ...createRuntimeRecords(events, runStaleReadBeforeWriteDetector(stale.reads, stale.currentVersions, stale.writes), "detector_stale-read-before-write"),
    ...createRuntimeRecords(events, runExportedContractInvalidationDetector(contracts.changes, contracts.consumers), "detector_exported-contract-invalidation"),
  ];
  return records.sort((left, right) => left.finding.payload.finding.findingId.localeCompare(right.finding.payload.finding.findingId));
}
