import assert from "node:assert/strict";
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
} from "@patchmesh/protocol";
import { projectWorkGraph, SqliteEventStore } from "@patchmesh/storage";

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

test("derives, persists, and deduplicates report-only same-symbol records from replayable evidence", () => {
  const events: readonly ProtocolEvent[] = [request, first, second, completion, firstEvidence, secondEvidence, concurrencyObservation];
  const reversed = [concurrencyObservation, secondEvidence, firstEvidence, completion, second, first, request];
  assert.equal(deriveSameSymbolEvidence(events).length, 2);
  const records = createSameSymbolRuntimeRecords(events);
  assert.deepEqual(createSameSymbolRuntimeRecords(reversed), records);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.decision.payload.decision.gatewayDirective, "allow_with_notice");

  const store = SqliteEventStore.open(":memory:");
  try {
    for (const event of events) store.append(event);
    for (const record of records) {
      assert.equal(store.append(record.finding).status, "inserted");
      assert.equal(store.append(record.decision).status, "inserted");
    }
    for (const record of createSameSymbolRuntimeRecords(store.read())) {
      assert.equal(store.append(record.finding).status, "duplicate");
      assert.equal(store.append(record.decision).status, "duplicate");
    }
  } finally {
    store.close();
  }
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
  assert.equal(stale.reads.length, 1);
  assert.equal(stale.writes.length, 1);
  assert.equal(stale.currentVersions.some((candidate) => candidate.resourceId === readResourceId && candidate.value === "sha256:after"), true);
  assert.equal(runStaleReadBeforeWriteDetector(stale.reads, stale.currentVersions, stale.writes).length, 1);
  const records = createPhase2RuntimeRecords(events);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.finding.payload.finding.findingType, "stale_read_before_write");
  assert.equal(records[0]?.finding.payload.finding.evidenceEventIds.includes(historicalChange.eventId), false);

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
  assert.equal(evidence.consumers.length, 1);
  assert.equal(evidence.changes.length, 1);
  assert.equal(
    createPhase2RuntimeRecords(events).filter((record) => record.finding.payload.finding.findingType === "exported_contract_invalidation").length,
    1,
  );
});
