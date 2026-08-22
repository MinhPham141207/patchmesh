import { createHash } from "node:crypto";
import { classifyContractCompatibility } from "patchmesh-analyzers";
import type { CoverageId, DerivedEvidenceEventV3, EventId, ProtocolEvent, ResourceVersion, TargetSnapshot } from "patchmesh-protocol";
import { projectWorkGraph } from "patchmesh-storage";

import { createDurableReportOnlyRecords, type DurableReportOnlyRecords } from "./durable-records.js";
import { runExportedContractInvalidationDetector, runSameSymbolDetector, runStaleReadBeforeWriteDetector } from "./detector-runner.js";
import { evaluateReportOnlyPolicy } from "./report-only-policy.js";
import { decisionIdFor, findingIdFor } from "./stable-identities.js";
import type { DetectorFinding } from "./types.js";
import { groupConsumersByContract } from "./exported-contract-invalidation.js";
import type { ConsumerContractDependencyEvidence, ExportedContractChangeEvidence } from "./exported-contract-invalidation.js";
import type { SymbolChangeEvidence } from "./same-symbol-overlap.js";
import type { CurrentVersionEvidence, DependentWriteEvidence, ResourceReadEvidence } from "./stale-read-before-write.js";

const runtimeSource = { kind: "core" as const, sourceId: "source_phase2", instanceId: "00000000-0000-4000-8000-000000000002" };

function eventId(kind: "finding" | "decision", findingId: string): EventId {
  return `evt_${createHash("sha256").update(`${kind}:${findingId}`).digest("hex").slice(0, 32)}` as EventId;
}

function sameTarget(left: TargetSnapshot, right: TargetSnapshot): boolean {
  return left.repositoryId === right.repositoryId
    && left.targetSnapshotId === right.targetSnapshotId
    && left.digest === right.digest;
}

/**
 * Contract history is linked by the explicitly materialized symbol signature
 * and its immutable target, not by a worktree-local capture domain.
 */
function sameSymbolSignatureVersion(left: ResourceVersion, right: ResourceVersion): boolean {
  return left.resourceId === right.resourceId
    && left.domain.repositoryId === right.domain.repositoryId
    && left.kind === right.kind
    && left.value !== null
    && left.value === right.value;
}

function sameHashBoundSourceVersion(left: ResourceVersion, right: ResourceVersion): boolean {
  return left.resourceId === right.resourceId
    && left.domain.repositoryId === right.domain.repositoryId
    && left.kind === right.kind
    && left.value !== null
    && left.value === right.value;
}

function sourceBeforeVersion(
  symbol: Extract<ProtocolEvent, { eventType: "symbol.changed" }>,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
): ResourceVersion | null {
  if (symbol.causationId === null) return null;
  const source = eventsById.get(symbol.causationId);
  return source?.eventType === "file.changed" ? source.payload.beforeVersion : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sufficientCoverageIds(events: readonly ProtocolEvent[]): ReadonlyMap<EventId, CoverageId> {
  try {
    const matches = new Map<EventId, CoverageId[]>();
    for (const entry of projectWorkGraph(events).snapshot.coverage.filter((entry) => entry.presentation === "sufficient")) {
      for (const eventId of entry.evidenceEventIds) matches.set(eventId, [...(matches.get(eventId) ?? []), entry.coverageId]);
    }
    return new Map([...matches].flatMap(([id, ids]) => {
      const unique = [...new Set(ids)];
      return unique.length === 1 ? [[id, unique[0]!] as const] : [];
    }));
  } catch { return new Map(); }
}

function hasConflictingDuplicateIds(events: readonly ProtocolEvent[]): boolean {
  const payloads = new Map<EventId, string>();
  for (const event of events) {
    const canonical = canonicalJson(event);
    const existing = payloads.get(event.eventId);
    if (existing !== undefined && existing !== canonical) return true;
    payloads.set(event.eventId, canonical);
  }
  return false;
}

function coverageFor(event: ProtocolEvent, eventsById: ReadonlyMap<EventId, ProtocolEvent>, coverage: ReadonlyMap<EventId, CoverageId>): CoverageId | null {
  const visited = new Set<EventId>();
  let current: ProtocolEvent | undefined = event;
  while (current !== undefined && !visited.has(current.eventId)) {
    visited.add(current.eventId);
    const direct = coverage.get(current.eventId);
    if (direct !== undefined) return direct;
    current = current.causationId === null ? undefined : eventsById.get(current.causationId);
  }
  return null;
}

function hasCoverage(event: ProtocolEvent | undefined, expected: CoverageId, eventsById: ReadonlyMap<EventId, ProtocolEvent>, coverage: ReadonlyMap<EventId, CoverageId>): boolean {
  return event !== undefined && coverageFor(event, eventsById, coverage) === expected;
}

function isSufficientV3Derived(event: ProtocolEvent): event is DerivedEvidenceEventV3 {
  return event.eventType === "evidence.derived" && event.schemaVersion === 3 && event.payload.evidence.coverage.status === "sufficient";
}

/** Select equivalent V3 assertions deterministically; different assertions are ambiguous. */
function equivalentDerivedByTarget(events: readonly ProtocolEvent[], exactOne: boolean): ReadonlyMap<EventId, DerivedEvidenceEventV3> {
  const grouped = new Map<EventId, DerivedEvidenceEventV3[]>();
  for (const event of events) if (isSufficientV3Derived(event)) grouped.set(event.payload.evidence.targetEventId, [...(grouped.get(event.payload.evidence.targetEventId) ?? []), event]);
  const result = new Map<EventId, DerivedEvidenceEventV3>();
  for (const [target, matches] of grouped) {
    if (exactOne && matches.length !== 1) continue;
    const distinct = new Set(matches.map((item) => JSON.stringify(item.payload)));
    if (distinct.size !== 1) continue;
    result.set(target, [...matches].sort((a, b) => a.eventId.localeCompare(b.eventId))[0]!);
  }
  return result;
}

function sourceMatches(derived: DerivedEvidenceEventV3, eventsById: ReadonlyMap<EventId, ProtocolEvent>): boolean {
  const proof = derived.payload.evidence.proof;
  const binding = proof.sourceAnalysis;
  const source = eventsById.get(binding.sourceEventId);
  const sourceVersion = source?.eventType === "file.read" || source?.eventType === "symbol.read"
    ? source.payload.version
    : source?.eventType === "file.changed" || source?.eventType === "symbol.changed"
      ? source.payload.afterVersion
      : undefined;
  const expectedDigest = `sha256:${createHash("sha256").update(canonicalJson({ sourceResourceId: binding.sourceResourceId, sourceVersion })).digest("hex")}`;
  return binding.analysisInputDigest === expectedDigest
    && derived.payload.evidence.sourceEventIds.includes(binding.sourceEventId)
    && sourceVersion !== undefined
    && binding.sourceResourceId === sourceVersion.resourceId
    && canonicalJson(binding.sourceVersion) === canonicalJson(sourceVersion);
}

export function deriveSameSymbolEvidence(events: readonly ProtocolEvent[]): readonly SymbolChangeEvidence[] {
  if (hasConflictingDuplicateIds(events)) return [];
  const coverage = sufficientCoverageIds(events);
  const byId = new Map(events.map((event) => [event.eventId, event] as const));
  const metadata = equivalentDerivedByTarget(events, false);
  const candidates = new Map<EventId, Array<{ eventId: EventId; other: EventId; target: TargetSnapshot; coverageId: CoverageId }>>();
  for (const event of events) {
    if (event.eventType !== "task.concurrency.observed" || event.schemaVersion !== 3) continue;
    const observation = event.payload.observation;
    if (!hasCoverage(event, observation.coverageId, byId, coverage) || event.source.kind === "core") continue;
    const first = byId.get(observation.firstChangeEventId);
    const second = byId.get(observation.secondChangeEventId);
    const firstDerived = metadata.get(observation.firstChangeEventId);
    const secondDerived = metadata.get(observation.secondChangeEventId);
    if (first?.eventType !== "symbol.changed" || second?.eventType !== "symbol.changed"
      || first.agentId !== observation.firstAgentId || second.agentId !== observation.secondAgentId
      || first.taskId !== observation.firstTaskId || second.taskId !== observation.secondTaskId
      || first.worktreeId !== observation.firstWorktreeId || second.worktreeId !== observation.secondWorktreeId
      || first.repositoryId !== second.repositoryId || first.payload.resource.resourceId !== second.payload.resource.resourceId
      || first.agentId === second.agentId || first.taskId === second.taskId || first.worktreeId === second.worktreeId
      || firstDerived === undefined || secondDerived === undefined
      || coverageFor(firstDerived, byId, coverage) === null
      || coverageFor(secondDerived, byId, coverage) === null
      || firstDerived.payload.evidence.factKind !== "symbol" || secondDerived.payload.evidence.factKind !== "symbol"
      || firstDerived.payload.evidence.proof.kind !== "hash_bound_symbol_contract" || secondDerived.payload.evidence.proof.kind !== "hash_bound_symbol_contract"
      || !sourceMatches(firstDerived, byId) || !sourceMatches(secondDerived, byId)
      || !sameTarget(firstDerived.payload.evidence.targetSnapshot, observation.targetSnapshot)
      || !sameTarget(secondDerived.payload.evidence.targetSnapshot, observation.targetSnapshot)) continue;
    for (const [id, other] of [[first.eventId, second.eventId], [second.eventId, first.eventId]] as const) {
      candidates.set(id, [...(candidates.get(id) ?? []), { eventId: event.eventId, other, target: observation.targetSnapshot, coverageId: observation.coverageId }]);
    }
  }
  const concurrency = new Map<EventId, { eventId: EventId; target: TargetSnapshot; coverageId: CoverageId }>();
  for (const [id, assertions] of candidates) {
    const distinct = new Set(assertions.map((item) => `${item.other}\0${item.target.targetSnapshotId}\0${item.target.digest}\0${item.coverageId}`));
    if (distinct.size === 1) {
      const chosen = [...assertions].sort((a, b) => a.eventId.localeCompare(b.eventId))[0]!;
      concurrency.set(id, chosen);
    }
  }
  const result: SymbolChangeEvidence[] = [];
  for (const event of events) {
    if (event.eventType !== "symbol.changed" || event.payload.resource.kind !== "symbol") continue;
    const coverageId = coverageFor(event, byId, coverage);
    const derived = metadata.get(event.eventId);
    const observed = concurrency.get(event.eventId);
    if (coverageId === null || derived === undefined || coverageFor(derived, byId, coverage) === null || observed === undefined || derived.payload.evidence.factKind !== "symbol"
      || derived.payload.evidence.proof.kind !== "hash_bound_symbol_contract" || !sourceMatches(derived, byId)
      || !sameTarget(derived.payload.evidence.targetSnapshot, observed.target)) continue;
    result.push({ eventId: event.eventId, resourceId: event.payload.resource.resourceId, version: event.payload.afterVersion, agentId: event.agentId, taskId: event.taskId, worktreeId: event.worktreeId, coverageId, targetSnapshot: observed.target, concurrencyEventId: observed.eventId, concurrencyCoverageId: observed.coverageId });
  }
  return result.sort((a, b) => a.eventId.localeCompare(b.eventId));
}

export function deriveStaleReadEvidence(events: readonly ProtocolEvent[]): { readonly reads: readonly ResourceReadEvidence[]; readonly currentVersions: readonly CurrentVersionEvidence[]; readonly writes: readonly DependentWriteEvidence[] } {
  if (hasConflictingDuplicateIds(events)) return { reads: [], currentVersions: [], writes: [] };
  const coverage = sufficientCoverageIds(events);
  const byId = new Map(events.map((event) => [event.eventId, event] as const));
  const tokenDigestsByRead = new Map<EventId, Set<string>>();
  for (const event of events) {
    if (event.eventType === "write.dependent" && event.schemaVersion === 3) {
      const readEventId = event.payload.write.readToken.readEventId;
      tokenDigestsByRead.set(readEventId, new Set([...(tokenDigestsByRead.get(readEventId) ?? []), event.payload.write.readToken.tokenDigest]));
    }
  }
  const reads: ResourceReadEvidence[] = [];
  const currentVersions: CurrentVersionEvidence[] = [];
  const writes: DependentWriteEvidence[] = [];
  for (const event of events) {
    if (event.eventType !== "write.dependent" || event.schemaVersion !== 3 || event.taskId === null) continue;
    const write = event.payload.write;
    const read = byId.get(write.readToken.readEventId);
    const changed = byId.get(write.comparison.changedEventId);
    const effect = byId.get(write.writeEffectEventId);
    const completion = byId.get(write.completionEventId);
    const request = completion?.eventType === "tool.completed" ? byId.get(completion.payload.requestEventId) : undefined;
    if ((read?.eventType !== "file.read" && read?.eventType !== "symbol.read") || changed === undefined || (changed.eventType !== "file.changed" && changed.eventType !== "symbol.changed")
      || effect?.eventType !== "file.changed" || completion?.eventType !== "tool.completed" || request?.eventType !== "tool.requested"
      || !hasCoverage(event, write.coverageId, byId, coverage) || !hasCoverage(changed, write.comparison.coverageId, byId, coverage) || !hasCoverage(effect, write.writeEffectCoverageId, byId, coverage)
      || completion.payload.outcome !== "succeeded" || !completion.payload.effectEventIds.includes(effect.eventId) || !completion.payload.deterministicallyAttributedEffectEventIds?.includes(effect.eventId)
      || completion.correlationId !== event.correlationId || request.correlationId !== completion.correlationId || request.taskId !== event.taskId || request.repositoryId !== event.repositoryId || request.workspaceId !== event.workspaceId || request.worktreeId !== event.worktreeId
      || read.eventId !== write.dependsOnReadEventId || read.repositoryId !== write.readToken.repositoryId || read.workspaceId !== write.readToken.workspaceId || read.worktreeId !== write.readToken.worktreeId || read.taskId !== write.readToken.taskId || read.taskId !== event.taskId
      || read.payload.resource.resourceId !== write.readToken.resourceId || read.payload.version.value !== write.readToken.observedVersion.value || read.payload.version.kind !== write.readToken.observedVersion.kind
      || event.repositoryId !== write.readToken.repositoryId || event.workspaceId !== write.readToken.workspaceId || event.worktreeId !== write.readToken.worktreeId || !sameTarget(write.readToken.targetSnapshot, write.targetSnapshot)
      || effect.taskId !== event.taskId || completion.taskId !== event.taskId
      || (tokenDigestsByRead.get(write.readToken.readEventId)?.size ?? 0) !== 1) continue;
    const readCoverage = coverageFor(read, byId, coverage);
    if (readCoverage === null) continue;
    reads.push({ eventId: read.eventId, taskId: read.taskId, resourceId: read.payload.resource.resourceId, version: read.payload.version, coverageId: readCoverage, targetSnapshot: write.targetSnapshot });
    currentVersions.push({ ...changed.payload.afterVersion, eventId: changed.eventId });
    writes.push({ eventId: event.eventId, dependencyId: write.dependencyId, taskId: event.taskId, resourceId: write.resourceId, dependsOnReadEventId: write.dependsOnReadEventId, coverageId: write.coverageId, comparisonChangedEventId: write.comparison.changedEventId, comparisonCoverageId: write.comparison.coverageId, targetSnapshot: write.targetSnapshot, readTokenDigest: write.readToken.tokenDigest, writeEffectEventId: effect.eventId, writeEffectCoverageId: write.writeEffectCoverageId, completionEventId: completion.eventId });
  }
  return { reads: reads.sort((a, b) => a.eventId.localeCompare(b.eventId)), currentVersions: currentVersions.sort((a, b) => String(a.eventId).localeCompare(String(b.eventId))), writes: writes.sort((a, b) => a.eventId.localeCompare(b.eventId)) };
}

export function deriveExportedContractInvalidationEvidence(events: readonly ProtocolEvent[]): { readonly changes: readonly ExportedContractChangeEvidence[]; readonly consumers: readonly ConsumerContractDependencyEvidence[] } {
  if (hasConflictingDuplicateIds(events)) return { changes: [], consumers: [] };
  const coverage = sufficientCoverageIds(events);
  const byId = new Map(events.map((event) => [event.eventId, event] as const));
  const metadata = equivalentDerivedByTarget(events, true);
  const consumers: ConsumerContractDependencyEvidence[] = [];
  for (const event of events) {
    if (event.eventType !== "dependency.changed") continue;
    const coverageId = coverageFor(event, byId, coverage);
    const derived = metadata.get(event.eventId);
    if (coverageId === null || derived === undefined || coverageFor(derived, byId, coverage) === null || derived.payload.evidence.factKind !== "dependency" || derived.payload.evidence.proof.kind !== "resolver_confirmed_consumer_dependency") continue;
    const proof = derived.payload.evidence.proof;
    if (!sourceMatches(derived, byId) || proof.contractResourceId !== event.payload.dependency.dependencyResourceId || proof.consumerResourceId !== event.payload.dependency.dependentResourceId || proof.dependencyId !== event.payload.dependency.dependencyId) continue;
    consumers.push({ eventId: event.eventId, dependencyId: event.payload.dependency.dependencyId, contractResourceId: event.payload.dependency.dependencyResourceId, consumerResourceId: event.payload.dependency.dependentResourceId, affectedTaskId: event.taskId, observedContractVersion: event.payload.dependency.dependencyVersion, coverageId, targetSnapshot: derived.payload.evidence.targetSnapshot });
  }
  const contracts = groupConsumersByContract(consumers);
  const eligibleSymbols: Array<{ event: Extract<ProtocolEvent, { eventType: "symbol.changed" }>; derived: DerivedEvidenceEventV3; coverageId: CoverageId }> = [];
  for (const event of events) {
    if (event.eventType !== "symbol.changed") continue;
    const coverageId = coverageFor(event, byId, coverage);
    const derived = metadata.get(event.eventId);
    if (coverageId === null || derived === undefined || coverageFor(derived, byId, coverage) === null || derived.payload.evidence.factKind !== "symbol" || !derived.payload.evidence.exported || derived.payload.evidence.proof.kind !== "hash_bound_symbol_contract" || !sourceMatches(derived, byId)) continue;
    eligibleSymbols.push({ event, derived, coverageId });
  }
  const changes: ExportedContractChangeEvidence[] = [];
  for (const current of eligibleSymbols) {
    if (current.event.payload.changeKind !== "modified" || current.event.payload.beforeVersion === null
      || current.derived.payload.evidence.normalizedSignature === null) continue;
    const currentSourceBefore = sourceBeforeVersion(current.event, byId);
    if (currentSourceBefore === null) continue;
    const prior = eligibleSymbols.filter((candidate) => candidate.event.eventId !== current.event.eventId
      && candidate.event.payload.resource.resourceId === current.event.payload.resource.resourceId
      && candidate.derived.payload.evidence.stableFactId === current.derived.payload.evidence.stableFactId
      && sameTarget(candidate.derived.payload.evidence.targetSnapshot, current.derived.payload.evidence.targetSnapshot)
      && sameSymbolSignatureVersion(candidate.event.payload.afterVersion, current.event.payload.beforeVersion!)
      && sameHashBoundSourceVersion(candidate.derived.payload.evidence.proof.sourceAnalysis.sourceVersion, currentSourceBefore));
    if (prior.length !== 1 || prior[0]!.derived.payload.evidence.normalizedSignature === null
      || classifyContractCompatibility(prior[0]!.derived.payload.evidence.normalizedSignature, current.derived.payload.evidence.normalizedSignature) !== "breaking"
      || !(contracts.get(current.event.payload.resource.resourceId)?.some((consumer) => sameTarget(consumer.targetSnapshot, current.derived.payload.evidence.targetSnapshot)) ?? false)) continue;
    changes.push({
      eventId: current.event.eventId,
      contractResourceId: current.event.payload.resource.resourceId,
      beforeVersion: current.event.payload.beforeVersion,
      afterVersion: current.event.payload.afterVersion,
      breaking: true,
      coverageId: current.coverageId,
      targetSnapshot: current.derived.payload.evidence.targetSnapshot,
    });
  }
  return { changes: changes.sort((a, b) => a.eventId.localeCompare(b.eventId)), consumers: consumers.sort((a, b) => a.eventId.localeCompare(b.eventId)) };
}

function createRuntimeRecords(events: readonly ProtocolEvent[], findings: readonly DetectorFinding[], detectorId: string): readonly DurableReportOnlyRecords[] {
  const byId = new Map(events.map((event) => [event.eventId, event] as const));
  return findings.map((finding) => {
    const parent = byId.get(finding.evidence.evidenceEventIds[0]!);
    if (parent === undefined) throw new Error("runtime finding references missing causal evidence");
    const findingId = findingIdFor(finding);
    const policy = evaluateReportOnlyPolicy({ finding, affectedTaskCompleted: false });
    return createDurableReportOnlyRecords(finding, { affectedTaskCompleted: false }, { findingId, decisionId: decisionIdFor(findingId, policy, finding.evidence.affectedTaskId), findingEventId: eventId("finding", findingId), decisionEventId: eventId("decision", findingId), repositoryId: parent.repositoryId, workspaceId: parent.workspaceId, worktreeId: parent.worktreeId, correlationId: parent.correlationId, source: runtimeSource, timestamp: parent.timestamp, sourceSequenceStart: null, detector: { detectorId, version: "1" }, policy: { policyId: "policy_report-only", version: "1" } });
  });
}

export function createSameSymbolRuntimeRecords(events: readonly ProtocolEvent[]): readonly DurableReportOnlyRecords[] {
  return createRuntimeRecords(events, runSameSymbolDetector(deriveSameSymbolEvidence(events)), "detector_same-symbol-overlap");
}

export function createPhase2RuntimeRecords(events: readonly ProtocolEvent[]): readonly DurableReportOnlyRecords[] {
  const stale = deriveStaleReadEvidence(events);
  const contracts = deriveExportedContractInvalidationEvidence(events);
  return [...createSameSymbolRuntimeRecords(events), ...createRuntimeRecords(events, runStaleReadBeforeWriteDetector(stale.reads, stale.currentVersions, stale.writes), "detector_stale-read-before-write"), ...createRuntimeRecords(events, runExportedContractInvalidationDetector(contracts.changes, contracts.consumers), "detector_exported-contract-invalidation")].sort((a, b) => a.finding.payload.finding.findingId.localeCompare(b.finding.payload.finding.findingId));
}
