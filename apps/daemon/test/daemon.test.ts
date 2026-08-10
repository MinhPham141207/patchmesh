import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import type { DecisionDeliveryChangedEvent, FindingCreatedEvent, FindingFeedbackCreatedEvent } from "@patchmesh/protocol";
import type { EventReader } from "@patchmesh/query";
import { ReadServiceError } from "@patchmesh/query";
import { SqliteEventStore } from "@patchmesh/storage";
import { createDaemon } from "../src/index.js";

const fixtureReader: EventReader = {
  read: () => [],
  replay: <State>(_reducer: { initialState(): State; apply(state: State, event: never): State }) => {
    throw new Error("fixture replay is not needed for composition");
  },
};

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
    causationId: null,
    sourceSequence: null,
    payload: {
      feedback: {
        feedbackId: `feedback_${"f".repeat(32)}`,
        findingId: `finding_${"f".repeat(32)}`,
        decisionId: null,
        actor: { agentId: "agent_a", taskId: "task_a" },
        disposition: "dismissed",
        useful: true,
        reason: "resolved by the task",
        evidenceEventIds: [`evt_${"e".repeat(32)}`],
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
  const decision: import("@patchmesh/protocol").DecisionCreatedEvent = {
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
    assert.deepEqual(daemon.runSameSymbolDetection(), []);
    assert.throws(
      () => daemon.runPhase2Detection(),
      (error: unknown) => error instanceof ReadServiceError && error.code === "unavailable",
    );

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
