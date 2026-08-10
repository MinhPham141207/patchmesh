import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProtocolValidationError,
  parseEvent,
  validateEventSet,
} from "../src/index.js";
import type {
  DecisionCreatedEvent,
  DependentWriteEvent,
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
  makeFindingCreated,
  makeFindingFeedbackCreated,
  makeDecisionCreated,
  makeToolCompleted,
  makeToolRequested,
} from "./fixtures.js";

const acceptsProtocolEvent = (_event: ProtocolEvent): void => undefined;

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
  const result = parseEvent({ ...makeToolRequested(), schemaVersion: 3 });
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
