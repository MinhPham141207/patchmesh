import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProtocolEvent } from "@patchmesh/protocol";
import { projectWorkGraph, SqliteEventStore } from "@patchmesh/storage";

import {
  createDecisionDeliveryChangedEvent,
  createDurableReportOnlyRecords,
  createFindingFeedbackCreatedEvent,
  type DetectorFinding,
} from "../src/index.js";

const parent: ProtocolEvent = {
  schemaVersion: 1, eventId: "evt_00000000000000000000000000000001", eventType: "tool.requested",
  source: { kind: "gateway", sourceId: "source_gateway", instanceId: "11111111-1111-4111-8111-111111111111" },
  timestamp: "2026-08-09T00:00:00.000Z", repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_11111111-1111-4111-8111-111111111111", worktreeId: "wt_11111111-1111-4111-8111-111111111111",
  agentId: "agent_agent-a", taskId: "task_task-a", correlationId: "corr_00000000000000000000000000000001",
  causationId: null, sourceSequence: 0,
  payload: { toolName: "edit_file", operation: "edit src/api.ts", targetResourceId: `res_${"a".repeat(64)}`, opaque: false },
};

const finding: DetectorFinding = {
  findingType: "same_symbol_overlap", confidence: 0.9, reason: "concurrent symbol change",
  evidence: {
    subjectResourceId: `res_${"a".repeat(64)}`, affectedTaskId: "task_task-a", dependencyIds: [],
    evidenceEventIds: [parent.eventId], coverageIds: [`coverage_${"b".repeat(32)}`],
  },
};

test("replays delivery and dismissed feedback as immutable decision responses", () => {
  const records = createDurableReportOnlyRecords(finding, { affectedTaskCompleted: false }, {
    findingId: `finding_${"c".repeat(32)}`, decisionId: `decision_${"d".repeat(32)}`,
    findingEventId: "evt_00000000000000000000000000000002", decisionEventId: "evt_00000000000000000000000000000003",
    repositoryId: parent.repositoryId, workspaceId: parent.workspaceId, worktreeId: parent.worktreeId,
    correlationId: parent.correlationId, source: { kind: "core", sourceId: "source_core", instanceId: "22222222-2222-4222-8222-222222222222" },
    timestamp: parent.timestamp, sourceSequenceStart: 0,
    detector: { detectorId: "detector_same-symbol", version: "1" }, policy: { policyId: "policy_report-only", version: "1" },
  });
  const delivery = createDecisionDeliveryChangedEvent({
    decisionId: records.decision.payload.decision.decisionId,
    delivery: {
      deliveryId: `delivery_${"e".repeat(32)}`, target: { agentId: "agent_agent-a", taskId: "task_task-a" },
      state: "delivered", eventIds: [records.decision.eventId],
    },
  }, {
    eventId: "evt_00000000000000000000000000000004", repositoryId: parent.repositoryId,
    workspaceId: parent.workspaceId, worktreeId: parent.worktreeId, correlationId: parent.correlationId,
    causationId: records.decision.eventId, source: records.decision.source, timestamp: parent.timestamp, sourceSequence: 2,
  });
  const feedback = createFindingFeedbackCreatedEvent({
    feedbackId: `feedback_${"f".repeat(32)}`, findingId: records.finding.payload.finding.findingId,
    decisionId: records.decision.payload.decision.decisionId, actor: { agentId: "agent_agent-a", taskId: "task_task-a" },
    disposition: "dismissed", useful: false, reason: "duplicate work", evidenceEventIds: [records.decision.eventId],
  }, {
    eventId: "evt_00000000000000000000000000000005", repositoryId: parent.repositoryId,
    workspaceId: parent.workspaceId, worktreeId: parent.worktreeId, correlationId: parent.correlationId,
    causationId: records.decision.eventId, source: records.decision.source, timestamp: parent.timestamp, sourceSequence: 3,
  });
  const store = SqliteEventStore.open(":memory:");
  try {
    for (const event of [parent, records.finding, records.decision, delivery, feedback]) store.append(event);
    const snapshot = projectWorkGraph(store.read()).snapshot;

    assert.equal(snapshot.findings[0]?.status, "dismissed");
    assert.equal(snapshot.decisions[0]?.deliveries[0]?.state, "delivered");
    assert.equal(snapshot.decisions[0]?.feedback[0]?.eventId, feedback.eventId);
    assert.equal(snapshot.decisions[0]?.feedback[0]?.feedback.reason, "duplicate work");
  } finally {
    store.close();
  }
});
