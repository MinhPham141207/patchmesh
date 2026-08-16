import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  ProtocolValidationError,
  parseEvent,
  validateEventSet,
} from "../src/index.js";
import type {
  DecisionCreatedEvent,
  DependentWriteEvent,
  DerivedEvidenceEvent,
  FindingCreatedEvent,
  FindingFeedbackCreatedEvent,
  ProtocolEvent,
} from "../src/index.js";
import {
  makeAllTypedEvents,
  makeAttributionCorrected,
  makeDependencyChanged,
  makeFileChanged,
  makeFileRead,
  makeSymbolChanged,
  makeFindingCreated,
  makeFindingFeedbackCreated,
  makeDecisionCreated,
  makeToolCompleted,
  makeToolRequested,
} from "./fixtures.js";

const acceptsProtocolEvent = (_event: ProtocolEvent): void => undefined;
const canonicalJson = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);

function v3Snapshot(repositoryId: string) {
  const input = { integrationTargetId: "target_main", repositoryId, kind: "branch", locator: "refs/heads/main", baseCommit: "a".repeat(40), candidateIds: [] } as const;
  const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
  return { targetSnapshotId: `snapshot_${digest}`, ...input, digest };
}

test("typed fixtures cover the full closed V1 event union", () => {
  const events = makeAllTypedEvents();
  for (const event of events) acceptsProtocolEvent(event);
  assert.deepEqual(events.map((event) => event.eventType), [
    "tool.requested",
    "tool.completed",
    "file.read",
    "file.changed",
    "symbol.read",
    "symbol.changed",
    "task.completed",
    "dependency.changed",
    "attribution.corrected",
    "finding.created",
    "decision.created",
    "validity.changed",
    "decision.delivery.changed",
  ]);
});

test("typed tool completion supports failed and interrupted outcomes", () => {
  const request = makeToolRequested();
  assert.equal(makeToolCompleted(request, "failed").payload.outcome, "failed");
  assert.equal(makeToolCompleted(request, "interrupted").payload.outcome, "interrupted");
});

test("typed tool events preserve nullable task attribution", () => {
  const request = makeToolRequested();
  assert.equal(request.agentId, "agent_a");
  assert.equal(request.taskId, null);
});

test("protocol validation errors expose sanitized diagnostics", () => {
  const error = new ProtocolValidationError([
    { code: "PHASE0_SCHEMA_INVALID", path: "/taskId", message: "required property is missing" },
  ]);
  assert.equal(error.name, "ProtocolValidationError");
  assert.deepEqual(error.diagnostics, [
    { code: "PHASE0_SCHEMA_INVALID", path: "/taskId", message: "required property is missing" },
  ]);
});

test("accepts a valid tool request at the boundary", () => {
  const result = parseEvent(makeToolRequested());
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.value?.eventType, "tool.requested");
});

test("rejects a payload for the wrong event type", () => {
  const result = parseEvent({
    ...makeToolRequested(),
    eventType: "tool.completed",
  });
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0]?.code, "PHASE0_SCHEMA_INVALID");
});

test("rejects an unsupported schema version", () => {
  const result = parseEvent({ ...makeToolRequested(), schemaVersion: 4 });
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0]?.code, "PHASE0_SCHEMA_UNSUPPORTED");
});

test("accepts an immutable V2 finding feedback event at the boundary", () => {
  const result = parseEvent(makeFindingFeedbackCreated());
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.value?.eventType, "finding.feedback.created");
  assert.equal(result.value?.schemaVersion, 2);
});

test("accepts a V2 dependent write event at the boundary", () => {
  const event: DependentWriteEvent = {
    ...makeFindingFeedbackCreated(),
    eventId: `evt_${"d".repeat(32)}`,
    eventType: "write.dependent",
    payload: {
      write: {
        dependencyId: `dep_${"d".repeat(32)}`,
        resourceId: `res_${"1".repeat(64)}`,
        dependsOnReadEventId: `evt_${"1".repeat(32)}`,
        coverageId: `coverage_${"d".repeat(32)}`,
      },
    },
  };
  const result = parseEvent(event);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.value?.eventType, "write.dependent");
});

test("accepts durable V2 derived-evidence provenance", () => {
  const target = makeSymbolChanged();
  const event: DerivedEvidenceEvent = {
    ...target,
    schemaVersion: 2,
    eventId: `evt_${"e".repeat(32)}`,
    eventType: "evidence.derived",
    source: { kind: "analyzer", sourceId: "source_typescript", instanceId: "22222222-2222-4222-8222-222222222222" },
    causationId: target.eventId,
    payload: {
      evidence: {
        targetEventId: target.eventId,
        factKind: "symbol",
        analyzer: { analyzerId: "analyzer_typescript", version: "1" },
        configuration: { parser: "typescript" },
        configurationDigest: "sha256:f8a4fe6e12fee58f81df0e17bc5a91622bc226ca5f4e5502edef985c7d0f3839",
        sourceEventIds: [target.eventId],
        integrationTarget: "main",
        coverage: { status: "sufficient", reason: "supported" },
        coverageId: `coverage_${"1".repeat(32)}`,
        stableFactId: target.payload.resource.resourceId,
        exported: true,
        normalizedSignature: "export function example(value: number): number",
      },
    },
  };

  assert.deepEqual(parseEvent(event).diagnostics, []);
  assert.deepEqual(validateEventSet([target, event]), []);
});

test("rejects derived evidence with a missing source event", () => {
  const target = makeSymbolChanged();
  const event = {
    ...target,
    schemaVersion: 2 as const,
    eventId: `evt_${"f".repeat(32)}` as const,
    eventType: "evidence.derived" as const,
    source: { kind: "analyzer" as const, sourceId: "source_typescript", instanceId: "22222222-2222-4222-8222-222222222222" },
    causationId: target.eventId,
    payload: {
      evidence: {
        targetEventId: target.eventId,
        factKind: "symbol" as const,
        analyzer: { analyzerId: "analyzer_typescript", version: "1" },
        configuration: { parser: "typescript" },
        configurationDigest: "sha256:f8a4fe6e12fee58f81df0e17bc5a91622bc226ca5f4e5502edef985c7d0f3839",
        sourceEventIds: [`evt_${"0".repeat(32)}`],
        integrationTarget: "main",
        coverage: { status: "sufficient" as const, reason: "supported" },
        coverageId: `coverage_${"1".repeat(32)}`,
        stableFactId: target.payload.resource.resourceId,
        exported: true,
        normalizedSignature: "export function example(value: number): number",
      },
    },
  };

  assert.equal(validateEventSet([target, event]).some((entry) => entry.code === "PHASE2_REFERENCE_MISSING"), true);
});

test("requires nullable attribution fields to be present", () => {
  const event = { ...makeToolRequested() } as Record<string, unknown>;
  delete event.taskId;
  const result = parseEvent(event);
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0]?.path, "/taskId");
});

test("accepts failed and interrupted tool outcomes", () => {
  const request = makeToolRequested();
  assert.equal(parseEvent(makeToolCompleted(request, "failed")).value?.eventType, "tool.completed");
  assert.equal(parseEvent(makeToolCompleted(request, "interrupted")).value?.eventType, "tool.completed");
});

test("accepts every Phase 1 input event shape at the boundary", () => {
  for (const event of makeAllTypedEvents().slice(0, 9)) {
    const result = parseEvent(event);
    assert.deepEqual(result.diagnostics, [], event.eventType);
    assert.equal(result.value?.eventType, event.eventType);
  }
});

test("preserves event identity and sequencing values through parsing", () => {
  const request = makeToolRequested();
  const result = parseEvent(request);
  assert.deepEqual(result.value, request);
});

test("accepts a causally ordered request and completion set", () => {
  const request = makeToolRequested();
  const completion = makeToolCompleted(request);
  assert.deepEqual(validateEventSet([request, completion]), []);
});

test("accepts deterministic watcher attribution on a tool completion", () => {
  const request = makeToolRequested();
  const changed = {
    ...makeFileChanged(),
    eventId: `evt_${"7".repeat(32)}` as const,
    source: { kind: "watcher" as const, sourceId: "source_watcher", instanceId: "22222222-2222-4222-8222-222222222222" },
    correlationId: request.correlationId,
    causationId: request.eventId,
  };
  const completion = {
    ...makeToolCompleted(request),
    payload: {
      ...makeToolCompleted(request).payload,
      effectEventIds: [changed.eventId],
      deterministicallyAttributedEffectEventIds: [changed.eventId],
    },
  };

  assert.deepEqual(parseEvent(completion).diagnostics, []);
  assert.deepEqual(validateEventSet([request, changed, completion]), []);
});

test("rejects deterministic attribution for a non-file-change effect", () => {
  const request = makeToolRequested();
  const completion = {
    ...makeToolCompleted(request),
    payload: {
      ...makeToolCompleted(request).payload,
      effectEventIds: [request.eventId],
      deterministicallyAttributedEffectEventIds: [request.eventId],
    },
  };

  assert.equal(validateEventSet([request, completion]).some((entry) =>
    entry.code === "PHASE0_SCHEMA_INVALID" && entry.path.endsWith("/deterministicallyAttributedEffectEventIds")), true);
});

test("rejects deterministic attribution on a failed tool completion", () => {
  const request = makeToolRequested();
  const changed = {
    ...makeFileChanged(),
    eventId: `evt_${"8".repeat(32)}` as const,
    source: { kind: "watcher" as const, sourceId: "source_watcher", instanceId: "22222222-2222-4222-8222-222222222222" },
    correlationId: request.correlationId,
    causationId: request.eventId,
  };
  const completion = {
    ...makeToolCompleted(request, "failed"),
    payload: {
      ...makeToolCompleted(request, "failed").payload,
      effectEventIds: [changed.eventId],
      deterministicallyAttributedEffectEventIds: [changed.eventId],
    },
  };

  assert.equal(validateEventSet([request, changed, completion]).some((entry) =>
    entry.code === "PHASE0_SCHEMA_INVALID" && entry.message.includes("succeeded tool completion")), true);
});

test("rejects a completion whose request is missing", () => {
  const completion = makeToolCompleted();
  const missingRequest = `evt_${"9".repeat(32)}`;
  const invalidCompletion = {
    ...completion,
    causationId: missingRequest,
    payload: { ...completion.payload, requestEventId: missingRequest },
  };
  const diagnostics = validateEventSet([invalidCompletion]);
  assert.equal(diagnostics[0]?.code, "PHASE0_REFERENCE_MISSING");
});

test("rejects a causal parent from another correlation", () => {
  const request = makeToolRequested();
  const completion = makeToolCompleted(request);
  const invalidRequest = { ...request, correlationId: "corr_99999999999999999999999999999999" };
  assert.equal(validateEventSet([invalidRequest, completion])[0]?.code, "PHASE0_SCHEMA_INVALID");
});

test("rejects a same-producer causal child that does not advance sequence", () => {
  const request = makeToolRequested();
  const completion = { ...makeToolCompleted(request), sourceSequence: 0 };
  assert.equal(validateEventSet([request, completion])[0]?.code, "PHASE0_SCHEMA_INVALID");
});

test("validates immutable attribution corrections against their target", () => {
  const request = makeToolRequested();
  assert.deepEqual(validateEventSet([request, makeAttributionCorrected()]), []);
});

test("rejects an attribution correction with a missing target", () => {
  const correction = makeAttributionCorrected();
  const invalidCorrection = {
    ...correction,
    payload: { ...correction.payload, targetEventId: `evt_${"9".repeat(32)}` },
  };
  assert.equal(validateEventSet([invalidCorrection])[0]?.code, "PHASE0_REFERENCE_MISSING");
});

test("rejects an attribution correction without an identity", () => {
  const request = makeToolRequested();
  const correction = makeAttributionCorrected();
  const invalidCorrection = {
    ...correction,
    payload: { ...correction.payload, attributedAgentId: null, attributedTaskId: null },
  };
  assert.equal(validateEventSet([request, invalidCorrection])[0]?.code, "PHASE0_SCHEMA_INVALID");
});

test("rejects V2 feedback that does not reference a stored finding", () => {
  const feedback = {
    ...makeFindingFeedbackCreated(),
    taskId: "task_a" as const,
  };
  const diagnostics = validateEventSet([feedback]);
  assert.equal(diagnostics.some((entry) =>
    entry.code === "PHASE2_REFERENCE_MISSING" && entry.path.endsWith("/feedback/findingId")), true);
});

test("accepts canonical V2 feedback references regardless of arrival order", () => {
  const finding = {
    ...makeFindingCreated(),
    eventId: `evt_${"a".repeat(32)}`,
    correlationId: `corr_${"a".repeat(32)}`,
    taskId: "task_a" as const,
    sourceSequence: 0,
    payload: {
      finding: {
        findingId: `finding_${"a".repeat(32)}`,
        findingType: "same_symbol_overlap" as const,
        status: "open" as const,
        subjectResourceId: `res_${"1".repeat(64)}`,
        affectedTaskId: "task_a" as const,
        dependencyIds: [],
        evidenceEventIds: [`evt_${"a".repeat(32)}`],
        confidence: 0.9,
        confidenceBand: "high" as const,
        severity: "warning" as const,
        coverageIds: [`coverage_${"a".repeat(32)}`],
        detector: { detectorId: "detector_phase2", version: "1" },
      },
    },
  } as FindingCreatedEvent;
  const decision = {
    ...makeDecisionCreated(),
    eventId: `evt_${"b".repeat(32)}`,
    correlationId: finding.correlationId,
    causationId: finding.eventId,
    taskId: "task_a" as const,
    sourceSequence: 1,
    payload: {
      decision: {
        decisionId: `decision_${"b".repeat(32)}`,
        findingId: finding.payload.finding.findingId,
        target: { agentId: "agent_a", taskId: "task_a" },
        coordinationAction: "notify",
        gatewayDirective: "allow_with_notice",
        reason: "overlap is confirmed",
        evidenceEventIds: [finding.eventId],
        confidence: 0.9,
        confidenceBand: "high",
        policy: { policyId: "policy_phase2", version: "1" },
        expectedResponse: "affected",
        coverageIds: [`coverage_${"a".repeat(32)}`],
        state: "active",
        deliveries: [],
      },
    },
  } as DecisionCreatedEvent;
  const feedback = {
    ...makeFindingFeedbackCreated(),
    eventId: `evt_${"c".repeat(32)}`,
    correlationId: finding.correlationId,
    causationId: decision.eventId,
    taskId: "task_a" as const,
    sourceSequence: 2,
    payload: {
      feedback: {
        ...makeFindingFeedbackCreated().payload.feedback,
        findingId: finding.payload.finding.findingId,
        decisionId: decision.payload.decision.decisionId,
        actor: { agentId: "agent_a", taskId: "task_a" },
        evidenceEventIds: [finding.eventId, decision.eventId],
      },
    },
  } as FindingFeedbackCreatedEvent;

  assert.deepEqual(validateEventSet([finding, decision, feedback]), []);
  assert.deepEqual(validateEventSet([feedback, finding, decision]), []);
});

test("rejects a V2 dependent write without durable read, dependency, and change evidence", () => {
  const dependentWrite: DependentWriteEvent = {
    ...makeFindingFeedbackCreated(),
    eventId: `evt_${"e".repeat(32)}`,
    eventType: "write.dependent",
    taskId: "task_a",
    payload: {
      write: {
        dependencyId: `dep_${"e".repeat(32)}`,
        resourceId: `res_${"1".repeat(64)}`,
        dependsOnReadEventId: `evt_${"f".repeat(32)}`,
        coverageId: `coverage_${"e".repeat(32)}`,
      },
    },
  };
  const diagnostics = validateEventSet([dependentWrite]);
  assert.equal(diagnostics.some((entry) =>
    entry.code === "PHASE2_REFERENCE_MISSING" && entry.path.endsWith("/write/dependsOnReadEventId")), true);
  assert.equal(diagnostics.some((entry) =>
    entry.code === "PHASE2_REFERENCE_MISSING" && entry.path.endsWith("/write/dependencyId")), true);
  assert.equal(diagnostics.some((entry) =>
    entry.code === "PHASE2_REFERENCE_MISSING" && entry.path.endsWith("/causationId")), true);
});

test("accepts canonical V2 dependent-write references regardless of arrival order", () => {
  const dependency = {
    ...makeDependencyChanged(),
    sourceSequence: 1,
  };
  const readTemplate = makeFileRead();
  const read = {
    ...readTemplate,
    taskId: "task_a" as const,
    sourceSequence: 0,
    payload: {
      ...readTemplate.payload,
      resource: {
        ...readTemplate.payload.resource,
        resourceId: dependency.payload.dependency.dependencyResourceId,
        locator: "src/dependency.ts",
      },
      version: {
        ...readTemplate.payload.version,
        resourceId: dependency.payload.dependency.dependencyResourceId,
      },
    },
  };
  const change = {
    ...makeFileChanged(),
    taskId: "task_a" as const,
    sourceSequence: 2,
  };
  const dependentWrite: DependentWriteEvent = {
    ...makeFindingFeedbackCreated(),
    eventId: `evt_${"d".repeat(32)}`,
    eventType: "write.dependent",
    correlationId: change.correlationId,
    causationId: change.eventId,
    taskId: read.taskId,
    sourceSequence: 3,
    payload: {
      write: {
        dependencyId: dependency.payload.dependency.dependencyId,
        resourceId: change.payload.resource.resourceId,
        dependsOnReadEventId: read.eventId,
        coverageId: `coverage_${"d".repeat(32)}`,
      },
    },
  };

  assert.deepEqual(validateEventSet([read, dependency, change, dependentWrite]), []);
  assert.deepEqual(validateEventSet([dependentWrite, change, dependency, read]), []);

  const unrelatedRead = {
    ...read,
    payload: {
      ...read.payload,
      resource: { ...read.payload.resource, resourceId: change.payload.resource.resourceId },
      version: { ...read.payload.version, resourceId: change.payload.resource.resourceId },
    },
  };
  assert.equal(validateEventSet([unrelatedRead, dependency, change, dependentWrite]).some((entry) =>
    entry.code === "PHASE2_SCHEMA_INVALID" &&
    entry.message === "dependent write read resource does not match its dependency"), true);
});

test("requires a symbol comparison integration target to match sufficient derived evidence", () => {
  const request = makeToolRequested();
  const read = {
    ...makeFileRead(),
    taskId: "task_a" as const,
    sourceSequence: 0,
    causationId: request.eventId,
    correlationId: request.correlationId,
  };
  const dependency = {
    ...makeDependencyChanged(),
    eventId: `evt_${"6".repeat(32)}` as const,
    taskId: "task_a" as const,
    causationId: request.eventId,
    correlationId: request.correlationId,
    sourceSequence: 1,
    payload: {
      dependency: {
        ...makeDependencyChanged().payload.dependency,
        dependencyResourceId: read.payload.resource.resourceId,
      },
    },
  };
  const change = {
    ...makeSymbolChanged(),
    eventId: `evt_${"7".repeat(32)}` as const,
    taskId: "task_a" as const,
    causationId: request.eventId,
    correlationId: request.correlationId,
    sourceSequence: 2,
    payload: {
      ...makeSymbolChanged().payload,
      resource: { ...makeSymbolChanged().payload.resource, resourceId: dependency.payload.dependency.dependentResourceId },
    },
  };
  const write: DependentWriteEvent = {
    ...makeFindingFeedbackCreated(),
    eventId: `evt_${"8".repeat(32)}`,
    eventType: "write.dependent",
    taskId: "task_a",
    correlationId: request.correlationId,
    causationId: change.eventId,
    sourceSequence: 3,
    payload: {
      write: {
        dependencyId: dependency.payload.dependency.dependencyId,
        resourceId: change.payload.resource.resourceId,
        dependsOnReadEventId: read.eventId,
        coverageId: `coverage_${"8".repeat(32)}`,
        comparison: { changedEventId: change.eventId, coverageId: `coverage_${"7".repeat(32)}`, integrationTarget: "main" },
      },
    },
  };
  assert.equal(validateEventSet([request, read, dependency, change, write]).some((entry) =>
    entry.code === "PHASE2_SCHEMA_INVALID" && entry.path.endsWith("/comparison/integrationTarget")), true);
});

test("accepts a closed V3 derived-evidence proof and rejects a noncanonical target snapshot", () => {
  const source = {
    kind: "analyzer" as const,
    sourceId: "source_analyzer",
    instanceId: "11111111-1111-4111-8111-111111111111",
  };
  const target = makeSymbolChanged();
  const read = { ...makeFileRead(), sourceSequence: null };
  const snapshotInput = {
    integrationTargetId: "target_main",
    repositoryId: target.repositoryId,
    kind: "branch",
    locator: "refs/heads/main",
    baseCommit: "a".repeat(40),
    candidateIds: [],
  } as const;
  const digest = createHash("sha256").update(canonicalJson(snapshotInput)).digest("hex");
  const snapshot = { targetSnapshotId: `snapshot_${digest}`, ...snapshotInput, digest };
  const evidence = {
    schemaVersion: 3 as const,
    eventId: `evt_${"c".repeat(32)}`,
    eventType: "evidence.derived" as const,
    source,
    timestamp: target.timestamp,
    repositoryId: target.repositoryId,
    workspaceId: target.workspaceId,
    worktreeId: target.worktreeId,
    agentId: target.agentId,
    taskId: target.taskId,
    correlationId: target.correlationId,
    causationId: target.eventId,
    sourceSequence: 1,
    payload: {
      evidence: {
        targetEventId: target.eventId,
        factKind: "symbol" as const,
        analyzer: { analyzerId: "symbol_analyzer", version: "1" },
        configuration: {},
        configurationDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`,
        sourceEventIds: [read.eventId],
        integrationTarget: snapshot.integrationTargetId,
        coverage: { status: "sufficient" as const, reason: "complete proof input" },
        coverageId: `coverage_${"c".repeat(32)}`,
        stableFactId: target.payload.resource.resourceId,
        exported: true,
        normalizedSignature: "example(): void",
        targetSnapshot: snapshot,
        proof: {
          kind: "hash_bound_symbol_contract" as const,
          sourceAnalysis: {
            sourceEventId: read.eventId,
            sourceResourceId: read.payload.resource.resourceId,
            sourceVersion: read.payload.version,
            analysisInputDigest: `sha256:${createHash("sha256").update(canonicalJson({ sourceResourceId: read.payload.resource.resourceId, sourceVersion: read.payload.version })).digest("hex")}`,
          },
        },
      },
    },
  };
  assert.deepEqual(parseEvent(evidence).diagnostics, []);
  assert.deepEqual(validateEventSet([read, target, evidence]), []);
  const invalid = { ...evidence, eventId: `evt_${"d".repeat(32)}`, payload: { evidence: { ...evidence.payload.evidence, targetSnapshot: { ...snapshot, digest: "0".repeat(64) } } } };
  assert.equal(validateEventSet([read, target, invalid]).some((entry) => entry.code === "PHASE3_SCHEMA_INVALID" && entry.path.endsWith("/targetSnapshot/digest")), true);
  const changedSource = { ...makeFileChanged(), sourceSequence: null };
  const changedEvidence = {
    ...evidence,
    eventId: `evt_${"e".repeat(32)}`,
    payload: { evidence: {
      ...evidence.payload.evidence,
      sourceEventIds: [changedSource.eventId],
      proof: { kind: "hash_bound_symbol_contract" as const, sourceAnalysis: {
        sourceEventId: changedSource.eventId,
        sourceResourceId: changedSource.payload.resource.resourceId,
        sourceVersion: changedSource.payload.afterVersion,
        analysisInputDigest: `sha256:${createHash("sha256").update(canonicalJson({ sourceResourceId: changedSource.payload.resource.resourceId, sourceVersion: changedSource.payload.afterVersion })).digest("hex")}`,
      } },
    } },
  };
  assert.deepEqual(validateEventSet([changedSource, target, changedEvidence]), []);
});

test("accepts cross-workspace same-repository V3 concurrency only with distinct authoritative lifecycles", () => {
  const first = { ...makeSymbolChanged(), eventId: `evt_${"1".repeat(32)}`, taskId: "task_a" as const, agentId: "agent_a" as const, sourceSequence: null };
  const second = {
    ...makeSymbolChanged(), eventId: `evt_${"2".repeat(32)}`, taskId: "task_b" as const, agentId: "agent_b" as const,
    workspaceId: "ws_44444444-4444-4444-8444-444444444444" as const,
    worktreeId: "wt_55555555-5555-4555-8555-555555555555" as const,
    correlationId: "corr_22222222222222222222222222222222" as const,
    sourceSequence: null,
    payload: {
      ...makeSymbolChanged().payload,
      beforeVersion: null,
      afterVersion: {
        ...makeSymbolChanged().payload.afterVersion,
        domain: {
          repositoryId: makeSymbolChanged().repositoryId,
          workspaceId: "ws_44444444-4444-4444-8444-444444444444" as const,
          worktreeId: "wt_55555555-5555-4555-8555-555555555555" as const,
        },
      },
    },
  };
  const snapshot = v3Snapshot(first.repositoryId);
  const observation = {
    schemaVersion: 3 as const, eventId: `evt_${"3".repeat(32)}`, eventType: "task.concurrency.observed" as const,
    source: { kind: "gateway" as const, sourceId: "source_gateway", instanceId: "11111111-1111-4111-8111-111111111111" }, timestamp: first.timestamp,
    repositoryId: first.repositoryId, workspaceId: first.workspaceId, worktreeId: first.worktreeId, agentId: "agent_a" as const, taskId: "task_a" as const,
    correlationId: "corr_33333333333333333333333333333333" as const, causationId: null, sourceSequence: null,
    payload: { observation: { firstTaskId: first.taskId, secondTaskId: second.taskId, firstAgentId: first.agentId, secondAgentId: second.agentId, firstWorktreeId: first.worktreeId, secondWorktreeId: second.worktreeId, firstChangeEventId: first.eventId, secondChangeEventId: second.eventId, integrationTarget: snapshot.integrationTargetId, coverageId: `coverage_${"3".repeat(32)}`, targetSnapshot: snapshot, overlapProof: { kind: "authoritative_task_lifetimes" as const, firstLifecycleId: "life_a", secondLifecycleId: "life_b" } } },
  };
  assert.deepEqual(parseEvent(observation).diagnostics, []);
  assert.deepEqual(validateEventSet([first, second, observation]), []);
  const sameAgent = { ...observation, payload: { observation: { ...observation.payload.observation, secondAgentId: first.agentId } } };
  const wrongTarget = { ...observation, payload: { observation: { ...observation.payload.observation, integrationTarget: "target_other" } } };
  const sameLifecycle = { ...observation, payload: { observation: { ...observation.payload.observation, overlapProof: { kind: "authoritative_task_lifetimes" as const, firstLifecycleId: "life_a", secondLifecycleId: "life_a" } } } };
  const sameSymbolEvent = { ...observation, payload: { observation: { ...observation.payload.observation, secondChangeEventId: first.eventId } } };
  for (const invalid of [sameAgent, wrongTarget, sameLifecycle, sameSymbolEvent]) {
    assert.equal(validateEventSet([first, second, invalid]).some((entry) => entry.code === "PHASE3_SCHEMA_INVALID"), true);
  }
});

test("rejects V3 proof-kind mismatch, resolver endpoint mismatch, and conflicting duplicate event bodies", () => {
  const dependency = makeDependencyChanged();
  const snapshot = v3Snapshot(dependency.repositoryId);
  const evidence = {
    schemaVersion: 3 as const, eventId: `evt_${"4".repeat(32)}`, eventType: "evidence.derived" as const,
    source: { kind: "analyzer" as const, sourceId: "source_analyzer", instanceId: "11111111-1111-4111-8111-111111111111" }, timestamp: dependency.timestamp,
    repositoryId: dependency.repositoryId, workspaceId: dependency.workspaceId, worktreeId: dependency.worktreeId, agentId: "agent_a" as const, taskId: "task_a" as const, correlationId: dependency.correlationId, causationId: dependency.eventId, sourceSequence: null,
    payload: { evidence: { targetEventId: dependency.eventId, factKind: "dependency" as const, analyzer: { analyzerId: "analyzer", version: "1" }, configuration: {}, configurationDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`, sourceEventIds: [dependency.eventId], integrationTarget: snapshot.integrationTargetId, coverage: { status: "sufficient" as const, reason: "supported" }, coverageId: `coverage_${"4".repeat(32)}`, stableFactId: dependency.payload.dependency.dependencyId, exported: true, normalizedSignature: null, targetSnapshot: snapshot, proof: { kind: "hash_bound_symbol_contract" as const, sourceAnalysis: { sourceEventId: dependency.eventId, sourceResourceId: dependency.payload.dependency.dependencyResourceId, sourceVersion: dependency.payload.dependency.dependencyVersion, analysisInputDigest: `sha256:${createHash("sha256").update(canonicalJson({ sourceResourceId: dependency.payload.dependency.dependencyResourceId, sourceVersion: dependency.payload.dependency.dependencyVersion })).digest("hex")}` } } } },
  };
  assert.equal(validateEventSet([dependency, evidence]).some((entry) => entry.path.endsWith("/proof/kind")), true);
  const conflicting = { ...evidence, payload: { evidence: { ...evidence.payload.evidence, exported: false } } };
  assert.equal(validateEventSet([dependency, evidence, conflicting]).some((entry) => entry.message.includes("conflicting canonical content")), true);
});
