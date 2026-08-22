import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  validateEventSet,
  type DecisionDeliveryChangedEvent,
  type FindingCreatedEvent,
  type FindingFeedbackCreatedEvent,
  type ProtocolEvent,
  type SymbolChangedEvent,
  type ToolCompletedEvent,
  type ToolRequestedEvent,
} from "patchmesh-protocol";
import type { EventReader } from "patchmesh-query";
import { ReadServiceError } from "patchmesh-query";
import { projectWorkGraph, SqliteEventStore } from "patchmesh-storage";
import { createDaemon } from "../src/index.js";

const fixtureReader: EventReader = {
  read: () => [],
  replay: <State>(_reducer: { initialState(): State; apply(state: State, event: never): State }) => {
    throw new Error("fixture replay is not needed for composition");
  },
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function seedSameSymbolEvidence(store: SqliteEventStore): void {
  const domain = {
    repositoryId: "repo_11111111-1111-4111-8111-111111111111" as const,
    workspaceId: "ws_22222222-2222-4222-8222-222222222222" as const,
    worktreeId: "wt_33333333-3333-4333-8333-333333333333" as const,
  };
  const request: ToolRequestedEvent = {
    schemaVersion: 1,
    eventId: "evt_00000000000000000000000000000051",
    eventType: "tool.requested",
    source: { kind: "gateway", sourceId: "source_gateway", instanceId: "11111111-1111-4111-8111-111111111111" },
    timestamp: "2026-08-09T00:00:00.000Z",
    ...domain,
    agentId: null,
    taskId: null,
    correlationId: "corr_00000000000000000000000000000051",
    causationId: null,
    sourceSequence: 0,
    payload: { toolName: "edit_file", operation: "edit src/api.ts", targetResourceId: `res_${"a".repeat(64)}`, opaque: false },
  };
  const changed = (
    eventId: `evt_${string}`,
    agentId: SymbolChangedEvent["agentId"],
    taskId: SymbolChangedEvent["taskId"],
    value: string,
    worktreeId = domain.worktreeId,
  ): SymbolChangedEvent => {
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
  };
  const first = changed("evt_00000000000000000000000000000052", "agent_alpha", "task_alpha", `sha256:${"b".repeat(64)}`);
  const second = changed("evt_00000000000000000000000000000053", "agent_beta", "task_beta", `sha256:${"c".repeat(64)}`, "wt_44444444-4444-4444-8444-444444444444");
  const completion: ToolCompletedEvent = {
    ...request,
    eventId: "evt_00000000000000000000000000000054",
    eventType: "tool.completed",
    causationId: request.eventId,
    sourceSequence: 1,
    payload: { requestEventId: request.eventId, outcome: "succeeded", exitCode: 0, effectEventIds: [first.eventId, second.eventId] },
  };
  const coverageId = projectWorkGraph([request, first, second, completion]).snapshot.coverage
    .find((coverage) => coverage.presentation === "sufficient" && coverage.evidenceEventIds.includes(first.eventId))?.coverageId;
  if (coverageId === undefined) throw new Error("expected sufficient same-symbol coverage");
  const targetInput = {
    integrationTargetId: "target_main" as const,
    repositoryId: domain.repositoryId,
    kind: "branch" as const,
    locator: "main",
    baseCommit: "a".repeat(40),
    candidateIds: [] as readonly string[],
  };
  const digest = createHash("sha256").update(canonicalJson(targetInput)).digest("hex");
  const targetSnapshot = { ...targetInput, digest, targetSnapshotId: `snapshot_${digest}` as const };
  const proof = (target: SymbolChangedEvent, eventId: `evt_${string}`): ProtocolEvent => ({
    ...target,
    schemaVersion: 3,
    eventId,
    eventType: "evidence.derived",
    source: { kind: "analyzer", sourceId: "source_typescript", instanceId: "22222222-2222-4222-8222-222222222222" },
    causationId: target.eventId,
    payload: { evidence: {
      targetEventId: target.eventId,
      factKind: "symbol",
      analyzer: { analyzerId: "analyzer_typescript", version: "1" },
      configuration: {},
      configurationDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`,
      sourceEventIds: [target.eventId],
      integrationTarget: targetSnapshot.integrationTargetId,
      coverage: { status: "sufficient", reason: "proof" },
      coverageId,
      stableFactId: target.payload.resource.resourceId,
      exported: true,
      normalizedSignature: "export function account(): string",
      targetSnapshot,
      proof: {
        kind: "hash_bound_symbol_contract",
        sourceAnalysis: {
          sourceEventId: target.eventId,
          sourceResourceId: target.payload.resource.resourceId,
          sourceVersion: target.payload.afterVersion,
          analysisInputDigest: `sha256:${createHash("sha256").update(canonicalJson({ sourceResourceId: target.payload.resource.resourceId, sourceVersion: target.payload.afterVersion })).digest("hex")}`,
        },
      },
    } },
  });
  const observed: ProtocolEvent = {
    ...first,
    schemaVersion: 3,
    eventId: "evt_00000000000000000000000000000057",
    eventType: "task.concurrency.observed",
    source: request.source,
    taskId: null,
    causationId: first.eventId,
    payload: { observation: {
      firstTaskId: first.taskId!,
      secondTaskId: second.taskId!,
      firstAgentId: first.agentId!,
      secondAgentId: second.agentId!,
      firstWorktreeId: first.worktreeId,
      secondWorktreeId: second.worktreeId,
      firstChangeEventId: first.eventId,
      secondChangeEventId: second.eventId,
      integrationTarget: targetSnapshot.integrationTargetId,
      targetSnapshot,
      coverageId,
      overlapProof: { kind: "authoritative_task_lifetimes", firstLifecycleId: "lifecycle_alpha", secondLifecycleId: "lifecycle_beta" },
    } },
  };
  const events: readonly ProtocolEvent[] = [request, first, second, completion, proof(first, "evt_00000000000000000000000000000055"), proof(second, "evt_00000000000000000000000000000056"), observed];
  assert.deepEqual(validateEventSet(events), []);
  for (const event of events) store.append(event);
}

test("daemon composes public services without creating storage", () => {
  const daemon = createDaemon({ reader: fixtureReader });

  assert.equal(typeof daemon.services.getStatus, "function");
  assert.equal(daemon.health().store.state, "open");
  daemon.close();
  daemon.close();
});

test("daemon rejects a missing database without creating it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m6-daemon-"));
  const databasePath = join(directory, "missing", "events.sqlite");
  try {
    assert.throws(
      () => createDaemon({ databasePath }),
      (error: unknown) => error instanceof ReadServiceError && error.code === "unavailable",
    );
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("daemon treats a semantically invalid durable Phase 2 replay as unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-phase2-invalid-replay-"));
  const databasePath = join(directory, "events.sqlite");
  const invalidFeedback: FindingFeedbackCreatedEvent = {
    schemaVersion: 2,
    eventId: `evt_${"f".repeat(32)}`,
    eventType: "finding.feedback.created",
    source: { kind: "core", sourceId: "source_phase2", instanceId: "11111111-1111-4111-8111-111111111111" },
    timestamp: "2026-08-09T00:00:00.000Z",
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: "agent_a",
    taskId: "task_a",
    correlationId: `corr_${"f".repeat(32)}`,
    causationId: null,
    sourceSequence: null,
    payload: {
      feedback: {
        feedbackId: `feedback_${"f".repeat(32)}`,
        findingId: `finding_${"f".repeat(32)}`,
        decisionId: null,
        actor: { agentId: "agent_a", taskId: "task_a" },
        disposition: "dismissed",
        useful: false,
        reason: "missing finding reference",
        evidenceEventIds: [`evt_${"e".repeat(32)}`],
      },
    },
  };
  let daemon: ReturnType<typeof createDaemon> | null = null;
  try {
    const store = SqliteEventStore.open(databasePath);
    try {
      store.append(invalidFeedback);
    } finally {
      store.close();
    }
    daemon = createDaemon({ databasePath });
    assert.throws(
      () => daemon!.runSameSymbolDetection(),
      (error: unknown) => error instanceof ReadServiceError
        && error.code === "unavailable"
        && error.message === "same-symbol detection is unavailable because durable replay validation failed"
        && error.cause !== undefined,
    );
    assert.throws(
      () => daemon!.runPhase2Detection(),
      (error: unknown) => error instanceof ReadServiceError
        && error.code === "unavailable"
        && error.message === "Phase 2 detection is unavailable because durable replay validation failed"
        && error.cause !== undefined,
    );
  } finally {
    daemon?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("daemon rolls back each derived record and preserves persistence causes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-daemon-atomic-"));
  const databasePath = join(directory, "events.sqlite");
  let daemon: ReturnType<typeof createDaemon> | null = null;
  try {
    const seedStore = SqliteEventStore.open(databasePath);
    try {
      seedSameSymbolEvidence(seedStore);
    } finally {
      seedStore.close();
    }
    const triggerDatabase = new DatabaseSync(databasePath);
    try {
      triggerDatabase.exec(`
        CREATE TRIGGER abort_derived_decision
        BEFORE INSERT ON events
        WHEN NEW.event_type = 'decision.created'
        BEGIN
          SELECT RAISE(ABORT, 'derived decision trigger');
        END
      `);
    } finally {
      triggerDatabase.close();
    }
    daemon = createDaemon({ databasePath });
    const detections = [
      [
        "same-symbol",
        () => daemon!.runSameSymbolDetection(),
        "same-symbol detection could not persist derived records",
      ],
      [
        "Phase 2",
        () => daemon!.runPhase2Detection(),
        "Phase 2 detection could not persist derived records",
      ],
    ] as const;
    for (const [name, run, message] of detections) {
      assert.throws(
        run,
        (error: unknown) => {
          if (!(error instanceof ReadServiceError)) return false;
          assert.equal(error.code, "unavailable");
          assert.equal(error.message, message);
          assert.ok(error.cause instanceof Error, `${name} persistence error retains its SQLite cause`);
          assert.match(error.cause.message, /derived decision trigger/);
          return true;
        },
      );
      const verificationStore = SqliteEventStore.open(databasePath);
      try {
        assert.equal(verificationStore.read().some((event) => event.eventType === "finding.created"), false);
        assert.equal(verificationStore.read().some((event) => event.eventType === "decision.created"), false);
      } finally {
        verificationStore.close();
      }
    }
  } finally {
    daemon?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("daemon persists immutable finding feedback only through a writable store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m6-feedback-"));
  const databasePath = join(directory, "events.sqlite");
  const feedback: FindingFeedbackCreatedEvent = {
    schemaVersion: 2,
    eventId: `evt_${"f".repeat(32)}`,
    eventType: "finding.feedback.created",
    source: { kind: "core", sourceId: "source_phase2", instanceId: "11111111-1111-4111-8111-111111111111" },
    timestamp: "2026-08-09T00:00:00.000Z",
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: "agent_a",
    taskId: "task_a",
    correlationId: `corr_${"f".repeat(32)}`,
    causationId: `evt_${"a".repeat(32)}`,
    sourceSequence: null,
    payload: {
      feedback: {
        feedbackId: `feedback_${"f".repeat(32)}`,
        findingId: `finding_${"a".repeat(32)}`,
        decisionId: null,
        actor: { agentId: "agent_a", taskId: "task_a" },
        disposition: "dismissed",
        useful: true,
        reason: "resolved by the task",
        evidenceEventIds: [`evt_${"a".repeat(32)}`],
      },
    },
  };
  const delivery: DecisionDeliveryChangedEvent = {
    ...feedback,
    schemaVersion: 1,
    eventId: `evt_${"d".repeat(32)}`,
    eventType: "decision.delivery.changed",
    causationId: feedback.eventId,
    payload: {
      decisionId: `decision_${"d".repeat(32)}`,
      delivery: {
        deliveryId: `delivery_${"d".repeat(32)}`,
        target: { agentId: "agent_a", taskId: "task_a" },
        state: "delivered",
        eventIds: [feedback.eventId],
      },
    },
  };
  const finding: FindingCreatedEvent = {
    schemaVersion: 1,
    eventId: `evt_${"a".repeat(32)}`,
    eventType: "finding.created",
    source: { kind: "core", sourceId: "source_phase2", instanceId: "00000000-0000-4000-8000-000000000002" },
    timestamp: feedback.timestamp,
    repositoryId: feedback.repositoryId,
    workspaceId: feedback.workspaceId,
    worktreeId: feedback.worktreeId,
    agentId: null,
    taskId: "task_a",
    correlationId: feedback.correlationId,
    causationId: null,
    sourceSequence: null,
    payload: {
      finding: {
        findingId: `finding_${"a".repeat(32)}`,
        findingType: "same_symbol_overlap",
        status: "open",
        subjectResourceId: `res_${"a".repeat(64)}`,
        affectedTaskId: "task_a",
        dependencyIds: [],
        evidenceEventIds: [feedback.eventId],
        confidence: 0.9,
        confidenceBand: "high",
        severity: "warning",
        coverageIds: [`coverage_${"a".repeat(32)}`],
        detector: { detectorId: "detector_same-symbol-overlap", version: "1" },
      },
    },
  };
  const decision: import("patchmesh-protocol").DecisionCreatedEvent = {
    ...finding,
    eventId: `evt_${"b".repeat(32)}`,
    eventType: "decision.created",
    causationId: finding.eventId,
    payload: {
      decision: {
        decisionId: delivery.payload.decisionId,
        findingId: finding.payload.finding.findingId,
        target: { agentId: "agent_a", taskId: "task_a" },
        coordinationAction: "notify",
        gatewayDirective: "allow_with_notice",
        reason: "Report-only test decision",
        evidenceEventIds: [finding.eventId],
        confidence: 0.9,
        confidenceBand: "high",
        policy: { policyId: "policy_phase2", version: "1" },
        expectedResponse: "affected",
        coverageIds: finding.payload.finding.coverageIds,
        state: "active",
        deliveries: [],
      },
    },
  };
  let daemon: ReturnType<typeof createDaemon> | null = null;
  let readOnly: ReturnType<typeof createDaemon> | null = null;
  try {
    const initial = SqliteEventStore.open(databasePath);
    try {
      initial.append(finding);
      initial.append(decision);
    } finally {
      initial.close();
    }
    daemon = createDaemon({ databasePath });
    assert.equal(daemon.recordFindingFeedback(feedback).status, "inserted");
    assert.equal(daemon.recordFindingFeedback(feedback).status, "duplicate");
    assert.equal(daemon.recordDecisionDelivery(delivery).status, "inserted");
    assert.equal(daemon.respondToDecisionDelivery({
      decisionId: decision.payload.decision.decisionId,
      state: "acknowledged",
    }).status, "inserted");
    assert.equal(daemon.respondToDecisionDelivery({
      decisionId: decision.payload.decision.decisionId,
      state: "acknowledged",
    }).status, "duplicate");
    assert.equal(daemon.respondToFinding({
      findingId: finding.payload.finding.findingId,
      decisionId: null,
      actor: { agentId: "agent_a", taskId: "task_a" },
      disposition: "dismissed",
      useful: true,
      reason: "resolved by the task",
    }).status, "inserted");
    const verificationStore = SqliteEventStore.open(databasePath);
    try {
      assert.deepEqual(validateEventSet(verificationStore.read()), []);
    } finally {
      verificationStore.close();
    }
    assert.deepEqual(daemon.runSameSymbolDetection(), []);
    // Legacy V1/V2 records remain replayable but cannot be treated as
    // sufficient PR5 evidence, so detection safely produces no new records.
    assert.deepEqual(daemon.runPhase2Detection(), []);

    readOnly = createDaemon({ reader: fixtureReader });
    assert.throws(
      () => readOnly.recordFindingFeedback(feedback),
      (error: unknown) => error instanceof ReadServiceError && error.code === "unavailable",
    );
    assert.throws(
      () => readOnly.runSameSymbolDetection(),
      (error: unknown) => error instanceof ReadServiceError && error.code === "unavailable",
    );
    assert.throws(
      () => readOnly.runPhase2Detection(),
      (error: unknown) => error instanceof ReadServiceError && error.code === "unavailable",
    );
  } finally {
    daemon?.close();
    readOnly?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
