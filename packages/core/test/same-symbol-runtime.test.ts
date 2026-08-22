import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
  DependentWriteEvent,
  DependencyChangedEvent,
  FileChangedEvent,
  FileReadEvent,
  ProtocolEvent,
  SymbolChangedEvent,
  ToolCompletedEvent,
  ToolRequestedEvent,
} from "patchmesh-protocol";
import { validateEventSet } from "patchmesh-protocol";
import { projectWorkGraph, SqliteEventStore } from "patchmesh-storage";

import {
  createPhase2RuntimeRecords,
  createSameSymbolRuntimeRecords,
  deriveExportedContractInvalidationEvidence,
  deriveSameSymbolEvidence,
  deriveStaleReadEvidence,
  runStaleReadBeforeWriteDetector,
} from "../src/index.js";

const domain = {
  repositoryId: "repo_11111111-1111-4111-8111-111111111111" as const,
  workspaceId: "ws_22222222-2222-4222-8222-222222222222" as const,
  worktreeId: "wt_33333333-3333-4333-8333-333333333333" as const,
};
const request: ToolRequestedEvent = {
  schemaVersion: 1,
  eventId: "evt_00000000000000000000000000000001",
  eventType: "tool.requested",
  source: { kind: "gateway", sourceId: "source_gateway", instanceId: "11111111-1111-4111-8111-111111111111" },
  timestamp: "2026-08-09T00:00:00.000Z",
  ...domain,
  agentId: null,
  taskId: null,
  correlationId: "corr_00000000000000000000000000000001",
  causationId: null,
  sourceSequence: 0,
  payload: { toolName: "edit_file", operation: "edit src/api.ts", targetResourceId: `res_${"a".repeat(64)}`, opaque: false },
};

function changed(eventId: SymbolChangedEvent["eventId"], agentId: SymbolChangedEvent["agentId"], taskId: SymbolChangedEvent["taskId"], value: string, worktreeId = domain.worktreeId): SymbolChangedEvent {
  const resourceId = `res_${"a".repeat(64)}` as const;
  return {
    schemaVersion: 1,
    eventId,
    eventType: "symbol.changed",
    source: { kind: "analyzer", sourceId: "source_typescript", instanceId: "22222222-2222-4222-8222-222222222222" },
    timestamp: "2026-08-09T00:00:01.000Z",
    ...domain,
    worktreeId,
    agentId,
    taskId,
    correlationId: request.correlationId,
    causationId: request.eventId,
    sourceSequence: null,
    payload: {
      resource: { resourceId, repositoryId: domain.repositoryId, kind: "symbol", locator: "src/api.ts#Account" },
      beforeVersion: null,
      afterVersion: {
        resourceId,
        domain: { ...domain, worktreeId },
        kind: "symbol_signature",
        value,
        evidenceEventIds: [eventId],
      },
      changeKind: "modified",
    },
  };
}

const first = changed("evt_00000000000000000000000000000002", "agent_alpha", "task_alpha", `sha256:${"b".repeat(64)}`);
const second = changed("evt_00000000000000000000000000000003", "agent_beta", "task_beta", `sha256:${"c".repeat(64)}`, "wt_44444444-4444-4444-8444-444444444444");
const completion: ToolCompletedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000004",
  eventType: "tool.completed",
  causationId: request.eventId,
  sourceSequence: 1,
  payload: { requestEventId: request.eventId, outcome: "succeeded", exitCode: 0, effectEventIds: [first.eventId, second.eventId] },
};

const overlapCoverageId = projectWorkGraph([request, first, second, completion]).snapshot.coverage
  .find((coverage) => coverage.presentation === "sufficient" && coverage.evidenceEventIds.includes(first.eventId))!.coverageId;

const canonicalJson = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
    : JSON.stringify(value);
const targetSnapshot = (() => {
  const input = { integrationTargetId: "target_main" as const, repositoryId: domain.repositoryId, kind: "branch" as const, locator: "main", baseCommit: "a".repeat(40), candidateIds: [] as readonly string[] };
  const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
  return { targetSnapshotId: `snapshot_${digest}` as const, ...input, digest };
})();
function v3SymbolEvidence(
  target: SymbolChangedEvent,
  id: `evt_${string}`,
  signature: string,
  exported = true,
  source: SymbolChangedEvent | FileChangedEvent = target,
) {
  const sourceVersion = source.payload.afterVersion;
  return { ...target, schemaVersion: 3 as const, eventId: id, eventType: "evidence.derived" as const, source: { kind: "analyzer" as const, sourceId: "source_typescript", instanceId: "22222222-2222-4222-8222-222222222222" }, causationId: target.eventId,
    payload: { evidence: { targetEventId: target.eventId, factKind: "symbol" as const, analyzer: { analyzerId: "analyzer_typescript", version: "1" }, configuration: {}, configurationDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`, sourceEventIds: [source.eventId], integrationTarget: targetSnapshot.integrationTargetId, coverage: { status: "sufficient" as const, reason: "proof" }, coverageId: overlapCoverageId, stableFactId: target.payload.resource.resourceId, exported, normalizedSignature: signature, targetSnapshot, proof: { kind: "hash_bound_symbol_contract" as const, sourceAnalysis: { sourceEventId: source.eventId, sourceResourceId: source.payload.resource.resourceId, sourceVersion, analysisInputDigest: `sha256:${createHash("sha256").update(canonicalJson({ sourceResourceId: source.payload.resource.resourceId, sourceVersion })).digest("hex")}` } } } } };
}

function v3DependencyEvidence(target: DependencyChangedEvent, id: `evt_${string}`, source: SymbolChangedEvent) {
  const sourceVersion = source.payload.afterVersion;
  return { ...target, schemaVersion: 3 as const, eventId: id, eventType: "evidence.derived" as const, source: { kind: "analyzer" as const, sourceId: "source_typescript", instanceId: "22222222-2222-4222-8222-222222222222" }, causationId: target.eventId,
    payload: { evidence: { targetEventId: target.eventId, factKind: "dependency" as const, analyzer: { analyzerId: "analyzer_typescript", version: "1" }, configuration: {}, configurationDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`, sourceEventIds: [source.eventId], integrationTarget: targetSnapshot.integrationTargetId, coverage: { status: "sufficient" as const, reason: "proof" }, coverageId: overlapCoverageId, stableFactId: target.payload.dependency.dependencyId, exported: false, normalizedSignature: null, targetSnapshot, proof: { kind: "resolver_confirmed_consumer_dependency" as const, sourceAnalysis: { sourceEventId: source.eventId, sourceResourceId: source.payload.resource.resourceId, sourceVersion, analysisInputDigest: `sha256:${createHash("sha256").update(canonicalJson({ sourceResourceId: source.payload.resource.resourceId, sourceVersion })).digest("hex")}` }, resolver: { resolverId: "local-contract-resolver", version: "1" }, dependencyId: target.payload.dependency.dependencyId, consumerResourceId: target.payload.dependency.dependentResourceId, contractResourceId: target.payload.dependency.dependencyResourceId, resolution: "confirmed" as const } } } };
}

function derivedSymbolEvidence(target: SymbolChangedEvent, eventId: `evt_${string}`) {
  return {
    ...target,
    schemaVersion: 2 as const,
    eventId,
    eventType: "evidence.derived" as const,
    source: { kind: "analyzer" as const, sourceId: "source_typescript", instanceId: "22222222-2222-4222-8222-222222222222" },
    causationId: target.eventId,
    payload: { evidence: {
      targetEventId: target.eventId, factKind: "symbol" as const,
      analyzer: { analyzerId: "analyzer_typescript", version: "1" }, configuration: { parser: "typescript" },
      configurationDigest: "sha256:f8a4fe6e12fee58f81df0e17bc5a91622bc226ca5f4e5502edef985c7d0f3839",
      sourceEventIds: [target.eventId], integrationTarget: "main", coverage: { status: "sufficient" as const, reason: "supported" },
      coverageId: overlapCoverageId, stableFactId: target.payload.resource.resourceId, exported: true, normalizedSignature: "export symbol",
    } },
  };
}

const firstEvidence = derivedSymbolEvidence(first, "evt_00000000000000000000000000000005");
const secondEvidence = derivedSymbolEvidence(second, "evt_00000000000000000000000000000006");
const concurrencyObservation = {
  ...first,
  schemaVersion: 2 as const,
  eventId: "evt_00000000000000000000000000000007" as const,
  eventType: "task.concurrency.observed" as const,
  source: { kind: "gateway" as const, sourceId: "source_gateway", instanceId: "11111111-1111-4111-8111-111111111111" },
  causationId: first.eventId,
  taskId: null,
  payload: { observation: { firstTaskId: "task_alpha" as const, secondTaskId: "task_beta" as const, firstChangeEventId: first.eventId, secondChangeEventId: second.eventId, integrationTarget: "main", coverageId: overlapCoverageId } },
};

test("replays V2 same-symbol evidence without treating it as sufficient proof", () => {
  const events: readonly ProtocolEvent[] = [request, first, second, completion, firstEvidence, secondEvidence, concurrencyObservation];
  const reversed = [concurrencyObservation, secondEvidence, firstEvidence, completion, second, first, request];
  assert.equal(deriveSameSymbolEvidence(events).length, 0);
  const records = createSameSymbolRuntimeRecords(events);
  assert.deepEqual(createSameSymbolRuntimeRecords(reversed), records);
  assert.equal(records.length, 0);

  const store = SqliteEventStore.open(":memory:");
  try {
    for (const event of events) store.append(event);
    assert.deepEqual(createSameSymbolRuntimeRecords(store.read()), []);
  } finally {
    store.close();
  }
});

test("derives a V3 authoritative same-symbol proof and fails closed for target or proof conflicts", () => {
  const firstProof = v3SymbolEvidence(first, "evt_00000000000000000000000000000009", "export function account(): string");
  const secondProof = v3SymbolEvidence(second, "evt_0000000000000000000000000000000a", "export function account(): string");
  const observed = { ...first, schemaVersion: 3 as const, eventId: "evt_0000000000000000000000000000000b" as const, eventType: "task.concurrency.observed" as const, source: request.source, taskId: null, causationId: first.eventId,
    payload: { observation: { firstTaskId: first.taskId!, secondTaskId: second.taskId!, firstAgentId: first.agentId!, secondAgentId: second.agentId!, firstWorktreeId: first.worktreeId, secondWorktreeId: second.worktreeId, firstChangeEventId: first.eventId, secondChangeEventId: second.eventId, integrationTarget: targetSnapshot.integrationTargetId, targetSnapshot, coverageId: overlapCoverageId, overlapProof: { kind: "authoritative_task_lifetimes" as const, firstLifecycleId: "lifecycle_a", secondLifecycleId: "lifecycle_b" } } } };
  const events = [request, first, second, completion, firstProof, secondProof, observed] as const;
  assert.deepEqual(validateEventSet(events), []);
  assert.equal(deriveSameSymbolEvidence(events).length, 2);
  assert.equal(createSameSymbolRuntimeRecords(events).length, 1);
  assert.deepEqual(deriveSameSymbolEvidence([...events, { ...observed, eventId: "evt_0000000000000000000000000000000c" as const, payload: { observation: { ...observed.payload.observation, targetSnapshot: { ...targetSnapshot, digest: "b".repeat(64) } } } }]), []);
});

test("requires one unambiguous V3 assertion for independently attributed cross-workspace symbol overlap", () => {
  const firstProof = v3SymbolEvidence(first, "evt_00000000000000000000000000000021", "export function account(): string");
  const secondProof = v3SymbolEvidence(second, "evt_00000000000000000000000000000022", "export function account(): string");
  const observed = {
    ...first,
    schemaVersion: 3 as const,
    eventId: "evt_00000000000000000000000000000023" as const,
    eventType: "task.concurrency.observed" as const,
    source: request.source,
    taskId: "task_alpha" as const,
    agentId: "agent_alpha" as const,
    causationId: first.eventId,
    payload: { observation: {
      firstTaskId: first.taskId!, secondTaskId: second.taskId!, firstAgentId: first.agentId!, secondAgentId: second.agentId!,
      firstWorktreeId: first.worktreeId, secondWorktreeId: second.worktreeId,
      firstChangeEventId: first.eventId, secondChangeEventId: second.eventId,
      integrationTarget: targetSnapshot.integrationTargetId, targetSnapshot, coverageId: overlapCoverageId,
      overlapProof: { kind: "authoritative_task_lifetimes" as const, firstLifecycleId: "lifecycle_alpha", secondLifecycleId: "lifecycle_beta" },
    } },
  };
  const valid = [request, first, second, completion, firstProof, secondProof, observed] as const;
  assert.deepEqual(validateEventSet(valid), []);
  assert.equal(deriveSameSymbolEvidence(valid).length, 2);

  const sameAgent = { ...observed, eventId: "evt_00000000000000000000000000000024" as const, payload: { observation: { ...observed.payload.observation, secondAgentId: first.agentId! } } };
  const sameWorktree = { ...observed, eventId: "evt_00000000000000000000000000000025" as const, payload: { observation: { ...observed.payload.observation, secondWorktreeId: first.worktreeId } } };
  const differentSymbol = { ...second, eventId: "evt_00000000000000000000000000000026" as const, payload: { ...second.payload, resource: { ...second.payload.resource, resourceId: `res_${"d".repeat(64)}` as const } } };
  const differentSymbolProof = v3SymbolEvidence(differentSymbol, "evt_00000000000000000000000000000027", "export function account(): string");
  const wrongSymbol = { ...observed, eventId: "evt_00000000000000000000000000000028" as const, payload: { observation: { ...observed.payload.observation, secondChangeEventId: differentSymbol.eventId } } };
  const missingProof = valid.filter((event) => event.eventId !== secondProof.eventId);
  const conflictingProof = { ...secondProof, eventId: "evt_00000000000000000000000000000029" as const, payload: { evidence: { ...secondProof.payload.evidence, normalizedSignature: "export function account(): number" } } };
  const duplicate = { ...secondProof };
  const replaceObserved = <T extends ProtocolEvent>(replacement: T): readonly ProtocolEvent[] => valid.map((event) => event.eventId === observed.eventId ? replacement : event);

  for (const stream of [
    replaceObserved(sameAgent),
    replaceObserved(sameWorktree),
    [request, first, differentSymbol, completion, firstProof, differentSymbolProof, wrongSymbol],
    missingProof,
    [...valid, conflictingProof],
    [...valid, duplicate],
  ]) assert.deepEqual(deriveSameSymbolEvidence(stream), []);
});

test("derives an exported-contract finding from an explicit V3 symbol-version predecessor", () => {
  const fileResourceId = `res_${"d".repeat(64)}` as const;
  const priorSource: FileChangedEvent = {
    ...request,
    eventId: "evt_0000000000000000000000000000002e",
    eventType: "file.changed",
    source: { kind: "watcher", sourceId: "source_watcher", instanceId: "33333333-3333-4333-8333-333333333333" },
    agentId: null,
    taskId: null,
    causationId: request.eventId,
    sourceSequence: null,
    payload: {
      resource: { resourceId: fileResourceId, repositoryId: domain.repositoryId, kind: "file", locator: "src/api.ts" },
      beforeVersion: null,
      afterVersion: { resourceId: fileResourceId, domain, kind: "content_hash", value: "sha256:source-prior", evidenceEventIds: ["evt_0000000000000000000000000000002e"] },
      changeKind: "created",
    },
  };
  const currentSource: FileChangedEvent = {
    ...priorSource,
    eventId: "evt_0000000000000000000000000000002f",
    agentId: null,
    taskId: null,
    payload: {
      ...priorSource.payload,
      beforeVersion: priorSource.payload.afterVersion,
      afterVersion: { ...priorSource.payload.afterVersion, value: "sha256:source-current", evidenceEventIds: ["evt_0000000000000000000000000000002f"] },
      changeKind: "modified",
    },
  };
  const priorBase = changed("evt_00000000000000000000000000000031", "agent_alpha", "task_alpha", "sha256:prior");
  const prior: SymbolChangedEvent = {
    ...priorBase,
    causationId: priorSource.eventId,
    payload: { ...priorBase.payload, beforeVersion: null, changeKind: "created" },
  };
  const currentBase: SymbolChangedEvent = { ...changed("evt_00000000000000000000000000000032", "agent_beta", "task_beta", "sha256:current"), causationId: currentSource.eventId };
  const current: SymbolChangedEvent = {
    ...currentBase,
    payload: { ...currentBase.payload, beforeVersion: prior.payload.afterVersion, changeKind: "modified" },
  };
  const contractCompletion: ToolCompletedEvent = {
    ...completion,
    eventId: "evt_00000000000000000000000000000033",
    payload: {
      ...completion.payload,
      effectEventIds: [priorSource.eventId, currentSource.eventId],
      deterministicallyAttributedEffectEventIds: [priorSource.eventId, currentSource.eventId],
    },
  };
  const consumerResourceId = `res_${"e".repeat(64)}` as const;
  const dependency: DependencyChangedEvent = {
    ...current,
    eventId: "evt_00000000000000000000000000000034",
    eventType: "dependency.changed",
    causationId: current.eventId,
    payload: { dependency: {
      dependencyId: `dep_${"f".repeat(32)}`,
      dependentResourceId: consumerResourceId,
      dependencyResourceId: prior.payload.resource.resourceId,
      dependentVersion: { resourceId: consumerResourceId, domain: current.payload.afterVersion.domain, kind: "content_hash", value: "sha256:consumer", evidenceEventIds: ["evt_00000000000000000000000000000034"] },
      dependencyVersion: prior.payload.afterVersion,
      observations: [{ kind: "statically_observed", producer: { sourceId: "source_typescript", version: "1" }, rule: null, evidenceEventIds: [current.eventId] }],
      evidenceEventIds: [current.eventId],
    } },
  };
  assert.deepEqual(validateEventSet([request, priorSource, currentSource, prior, current, contractCompletion]), []);
  const withCoverage = <T extends { payload: { evidence: { coverageId: typeof overlapCoverageId } } }>(proof: T): T => ({ ...proof, payload: { ...proof.payload, evidence: { ...proof.payload.evidence, coverageId: overlapCoverageId } } });
  const priorProof = withCoverage(v3SymbolEvidence(prior, "evt_00000000000000000000000000000035", "export function api(value: number): number", true, priorSource));
  const currentProof = withCoverage(v3SymbolEvidence(current, "evt_00000000000000000000000000000036", "export function api(value: string): number", true, currentSource));
  const dependencyProof = withCoverage(v3DependencyEvidence(dependency, "evt_00000000000000000000000000000037", current));
  const events = [request, priorSource, currentSource, prior, current, contractCompletion, dependency, priorProof, currentProof, dependencyProof] as const;
  assert.deepEqual(validateEventSet(events), []);
  assert.equal(deriveExportedContractInvalidationEvidence(events).changes.length, 1);
  assert.equal(createPhase2RuntimeRecords(events).filter((record) => record.finding.payload.finding.findingType === "exported_contract_invalidation").length, 1);
  assert.deepEqual(deriveExportedContractInvalidationEvidence([...events].reverse()), deriveExportedContractInvalidationEvidence(events));

  const compatible = withCoverage(v3SymbolEvidence(current, "evt_00000000000000000000000000000038", "export function api(renamed: number): number"));
  const nonExported = withCoverage(v3SymbolEvidence(current, "evt_00000000000000000000000000000039", "export function api(value: string): number", false));
  const ambiguous = withCoverage(v3SymbolEvidence(current, "evt_0000000000000000000000000000003a", "export function api(value: boolean): number"));
  for (const stream of [
    [request, priorSource, currentSource, prior, current, contractCompletion, dependency, priorProof, compatible, dependencyProof],
    [request, priorSource, currentSource, prior, current, contractCompletion, dependency, priorProof, nonExported, dependencyProof],
    [...events, ambiguous],
  ]) assert.equal(deriveExportedContractInvalidationEvidence(stream).changes.length, 0);
});

test("rejects mismatched or competing concurrency coverage observations deterministically", () => {
  const mismatched = {
    ...concurrencyObservation,
    payload: { observation: { ...concurrencyObservation.payload.observation, coverageId: `coverage_${"2".repeat(32)}` } },
  };
  assert.deepEqual(deriveSameSymbolEvidence([request, first, second, firstEvidence, secondEvidence, mismatched]), []);

  const competing = {
    ...concurrencyObservation,
    eventId: "evt_00000000000000000000000000000008" as const,
    payload: { observation: { ...concurrencyObservation.payload.observation, integrationTarget: "release" } },
  };
  const forward = [request, first, second, firstEvidence, secondEvidence, concurrencyObservation, competing] as const;
  assert.deepEqual(deriveSameSymbolEvidence(forward), []);
  assert.deepEqual(deriveSameSymbolEvidence([...forward].reverse()), []);
});

test("suppresses symbol changes when coverage cannot be proven", () => {
  assert.deepEqual(deriveSameSymbolEvidence([first, second]), []);
  assert.deepEqual(createSameSymbolRuntimeRecords([request, first, second]), []);
});

test("reconstructs and persists stale-read findings from causally covered V2 writes", () => {
  const readResourceId = `res_${"d".repeat(64)}` as const;
  const writtenResourceId = `res_${"e".repeat(64)}` as const;
  const taskId = "task_alpha" as const;
  const version = (resourceId: typeof readResourceId | typeof writtenResourceId, value: string, eventId: string, worktreeId = domain.worktreeId) => ({
    resourceId,
    domain: { ...domain, worktreeId },
    kind: "content_hash" as const,
    value,
    evidenceEventIds: [eventId as `evt_${string}`],
  });
  const readRequest: ToolRequestedEvent = {
    ...request,
    eventId: "evt_00000000000000000000000000000010",
    taskId,
    sourceSequence: null,
    payload: { ...request.payload, toolName: "read_file", targetResourceId: readResourceId },
  };
  const read: FileReadEvent = {
    ...readRequest,
    eventId: "evt_00000000000000000000000000000011",
    eventType: "file.read",
    causationId: readRequest.eventId,
    payload: {
      resource: { resourceId: readResourceId, repositoryId: domain.repositoryId, kind: "file", locator: "src/input.ts" },
      version: version(readResourceId, "sha256:before", "evt_00000000000000000000000000000011"),
      access: "read",
    },
  };
  const readCompletion: ToolCompletedEvent = {
    ...readRequest,
    eventId: "evt_00000000000000000000000000000012",
    eventType: "tool.completed",
    causationId: readRequest.eventId,
    payload: { requestEventId: readRequest.eventId, outcome: "succeeded", exitCode: 0, effectEventIds: [] },
  };
  const historicalRequest: ToolRequestedEvent = {
    ...readRequest,
    eventId: "evt_00000000000000000000000000000008",
    taskId: "task_history",
    correlationId: "corr_00000000000000000000000000000008",
  };
  const historicalChange: FileChangedEvent = {
    ...historicalRequest,
    eventId: "evt_00000000000000000000000000000009",
    eventType: "file.changed",
    causationId: historicalRequest.eventId,
    payload: {
      resource: { resourceId: readResourceId, repositoryId: domain.repositoryId, kind: "file", locator: "src/input.ts" },
      beforeVersion: null,
      afterVersion: version(readResourceId, "sha256:older", "evt_00000000000000000000000000000009"),
      changeKind: "created",
    },
  };
  const historicalCompletion: ToolCompletedEvent = {
    ...historicalRequest,
    eventId: "evt_0000000000000000000000000000000a",
    eventType: "tool.completed",
    causationId: historicalRequest.eventId,
    payload: { requestEventId: historicalRequest.eventId, outcome: "succeeded", exitCode: 0, effectEventIds: [historicalChange.eventId] },
  };
  const currentRequest: ToolRequestedEvent = {
    ...readRequest,
    eventId: "evt_00000000000000000000000000000013",
    taskId: "task_beta",
    worktreeId: "wt_44444444-4444-4444-8444-444444444444",
    correlationId: "corr_00000000000000000000000000000013",
  };
  const current: FileChangedEvent = {
    ...currentRequest,
    eventId: "evt_00000000000000000000000000000014",
    eventType: "file.changed",
    causationId: currentRequest.eventId,
    payload: {
      resource: { resourceId: readResourceId, repositoryId: domain.repositoryId, kind: "file", locator: "src/input.ts" },
      beforeVersion: version(readResourceId, "sha256:before", "evt_00000000000000000000000000000014", currentRequest.worktreeId),
      afterVersion: version(readResourceId, "sha256:after", "evt_00000000000000000000000000000014", currentRequest.worktreeId),
      changeKind: "modified",
    },
  };
  const currentCompletion: ToolCompletedEvent = {
    ...currentRequest,
    eventId: "evt_00000000000000000000000000000015",
    eventType: "tool.completed",
    causationId: currentRequest.eventId,
    payload: { requestEventId: currentRequest.eventId, outcome: "succeeded", exitCode: 0, effectEventIds: [current.eventId] },
  };
  const writeRequest: ToolRequestedEvent = {
    ...readRequest,
    eventId: "evt_00000000000000000000000000000016",
    correlationId: "corr_00000000000000000000000000000016",
    payload: { ...readRequest.payload, toolName: "edit_file", targetResourceId: writtenResourceId },
  };
  const written: FileChangedEvent = {
    ...writeRequest,
    eventId: "evt_00000000000000000000000000000017",
    eventType: "file.changed",
    causationId: writeRequest.eventId,
    payload: {
      resource: { resourceId: writtenResourceId, repositoryId: domain.repositoryId, kind: "file", locator: "src/output.ts" },
      beforeVersion: null,
      afterVersion: version(writtenResourceId, "sha256:output", "evt_00000000000000000000000000000017"),
      changeKind: "created",
    },
  };
  const writeCompletion: ToolCompletedEvent = {
    ...writeRequest,
    eventId: "evt_00000000000000000000000000000018",
    eventType: "tool.completed",
    causationId: writeRequest.eventId,
    payload: { requestEventId: writeRequest.eventId, outcome: "succeeded", exitCode: 0, effectEventIds: [written.eventId] },
  };
  const coverageFor = (events: readonly ProtocolEvent[], evidenceEventId: string) => projectWorkGraph(events).snapshot.coverage
    .find((coverage) => coverage.presentation === "sufficient" && coverage.evidenceEventIds.includes(evidenceEventId))!.coverageId;
  const writeCoverageId = coverageFor([writeRequest, written, writeCompletion], written.eventId);
  const comparisonCoverageId = coverageFor([currentRequest, current, currentCompletion], current.eventId);
  const dependentWrite: DependentWriteEvent = {
    ...writeRequest,
    schemaVersion: 2,
    eventId: "evt_00000000000000000000000000000019",
    eventType: "write.dependent",
    causationId: written.eventId,
    payload: { write: {
      dependencyId: `dep_${"f".repeat(32)}`,
      resourceId: writtenResourceId,
      dependsOnReadEventId: read.eventId,
      coverageId: writeCoverageId,
      comparison: { changedEventId: current.eventId, coverageId: comparisonCoverageId, integrationTarget: "main" },
    } },
  };
  const dependency: DependencyChangedEvent = {
    ...writeRequest,
    eventId: "evt_00000000000000000000000000000020",
    eventType: "dependency.changed",
    correlationId: "corr_00000000000000000000000000000020",
    causationId: null,
    payload: {
      dependency: {
        dependencyId: dependentWrite.payload.write.dependencyId,
        dependentResourceId: writtenResourceId,
        dependencyResourceId: readResourceId,
        dependentVersion: written.payload.afterVersion,
        dependencyVersion: read.payload.version,
        observations: [{
          kind: "dynamically_observed",
          producer: { sourceId: writeRequest.source.sourceId, version: "1" },
          rule: null,
          evidenceEventIds: [written.eventId],
        }],
        evidenceEventIds: [written.eventId, read.eventId],
      },
    },
  };
  const events: readonly ProtocolEvent[] = [
    historicalRequest, historicalChange, historicalCompletion,
    readRequest, read, readCompletion, currentRequest, current, currentCompletion,
    writeRequest, written, writeCompletion, dependentWrite, dependency,
  ];

  const stale = deriveStaleReadEvidence(events);
  assert.equal(stale.reads.length, 0);
  assert.equal(stale.writes.length, 0);
  assert.equal(stale.currentVersions.length, 0);
  assert.equal(runStaleReadBeforeWriteDetector(stale.reads, stale.currentVersions, stale.writes).length, 0);
  const records = createPhase2RuntimeRecords(events);
  assert.equal(records.length, 0);

  const mismatchedComparison = {
    ...dependentWrite,
    payload: { write: {
      ...dependentWrite.payload.write,
      comparison: { ...dependentWrite.payload.write.comparison!, coverageId: `coverage_${"2".repeat(32)}` },
    } },
  };
  assert.equal(deriveStaleReadEvidence(events.map((event) => event.eventId === dependentWrite.eventId ? mismatchedComparison : event)).writes.length, 0);
});

test("reconstructs contract invalidation from durable cross-worktree history", () => {
  const dependencyResourceId = `res_${"e".repeat(64)}` as const;
  const dependencyId = `dep_${"f".repeat(32)}` as const;
  const dependency: DependencyChangedEvent = {
    ...request,
    eventId: "evt_00000000000000000000000000000005",
    eventType: "dependency.changed",
    source: second.source,
    agentId: second.agentId,
    taskId: second.taskId,
    sourceSequence: null,
    causationId: first.eventId,
    payload: {
      dependency: {
        dependencyId,
        dependentResourceId: dependencyResourceId,
        dependencyResourceId: first.payload.resource.resourceId,
        dependentVersion: {
          resourceId: dependencyResourceId,
          domain: first.payload.afterVersion.domain,
          kind: "content_hash",
          value: "sha256:consumer",
          evidenceEventIds: ["evt_00000000000000000000000000000005"],
        },
        dependencyVersion: first.payload.afterVersion,
        observations: [{
          kind: "statically_observed",
          producer: { sourceId: "source_typescript", version: "1" },
          rule: null,
          evidenceEventIds: [first.eventId],
        }],
        evidenceEventIds: [first.eventId, "evt_00000000000000000000000000000005"],
      },
    },
  };
  const derivedEvidence = (
    target: ProtocolEvent,
    eventId: `evt_${string}`,
    factKind: "symbol" | "dependency",
    stableFactId: string,
    normalizedSignature: string,
    sourceEventIds: readonly `evt_${string}`[],
  ) => ({
    ...target,
    schemaVersion: 2 as const,
    eventId,
    eventType: "evidence.derived" as const,
    source: { kind: "analyzer" as const, sourceId: "source_typescript", instanceId: "22222222-2222-4222-8222-222222222222" },
    causationId: target.eventId,
    payload: {
      evidence: {
        targetEventId: target.eventId,
        factKind,
        analyzer: { analyzerId: "analyzer_typescript", version: "1" },
        configuration: { parser: "typescript" },
        configurationDigest: "sha256:f8a4fe6e12fee58f81df0e17bc5a91622bc226ca5f4e5502edef985c7d0f3839",
        sourceEventIds,
        integrationTarget: "main",
        coverage: { status: "sufficient" as const, reason: "supported" },
        coverageId: `coverage_${"1".repeat(32)}`,
        stableFactId,
        exported: factKind === "symbol",
        normalizedSignature,
      },
    },
  });
  const priorEvidence = derivedEvidence(
    first,
    "evt_00000000000000000000000000000006",
    "symbol",
    first.payload.resource.resourceId,
    "export function calculate(value: number): number",
    [first.eventId],
  );
  const currentEvidence = derivedEvidence(
    second,
    "evt_00000000000000000000000000000007",
    "symbol",
    second.payload.resource.resourceId,
    "export function calculate(value: string): number",
    [second.eventId],
  );
  const dependencyEvidence = derivedEvidence(
    dependency,
    "evt_00000000000000000000000000000008",
    "dependency",
    dependencyId,
    "export function calculate(value: number): number",
    dependency.payload.dependency.evidenceEventIds,
  );
  const events: readonly ProtocolEvent[] = [request, first, second, completion, dependency, priorEvidence, currentEvidence, dependencyEvidence];

  const evidence = deriveExportedContractInvalidationEvidence(events);
  assert.equal(evidence.consumers.length, 0);
  assert.equal(evidence.changes.length, 0);
  assert.equal(
    createPhase2RuntimeRecords(events).filter((record) => record.finding.payload.finding.findingType === "exported_contract_invalidation").length,
    0,
  );
});
