import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProtocolEvent } from "patchmesh-protocol";
import { SqliteEventStore } from "patchmesh-storage";

import {
  createDurableReportOnlyRecords,
  type DetectorFinding,
} from "../src/index.js";

const parent: ProtocolEvent = {
  schemaVersion: 1,
  eventId: "evt_00000000000000000000000000000001",
  eventType: "tool.requested",
  source: { kind: "gateway", sourceId: "source_gateway", instanceId: "11111111-1111-4111-8111-111111111111" },
  timestamp: "2026-08-09T00:00:00.000Z",
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_11111111-1111-4111-8111-111111111111",
  worktreeId: "wt_11111111-1111-4111-8111-111111111111",
  agentId: "agent_agent-a",
  taskId: "task_task-a",
  correlationId: "corr_00000000000000000000000000000001",
  causationId: null,
  sourceSequence: 0,
  payload: { toolName: "edit_file", operation: "edit src/api.ts", targetResourceId: `res_${"a".repeat(64)}`, opaque: false },
};

const finding: DetectorFinding = {
  findingType: "stale_read_before_write",
  confidence: 0.9,
  reason: "the resource version changed after the task read it",
  evidence: {
    subjectResourceId: `res_${"a".repeat(64)}`,
    affectedTaskId: "task_task-a",
    dependencyIds: [],
    evidenceEventIds: [parent.eventId],
    coverageIds: [`coverage_${"b".repeat(32)}`],
  },
};

test("creates appendable report-only finding and decision records", () => {
  const records = createDurableReportOnlyRecords(finding, { affectedTaskCompleted: true }, {
    findingId: `finding_${"c".repeat(32)}`,
    decisionId: `decision_${"d".repeat(32)}`,
    findingEventId: "evt_00000000000000000000000000000002",
    decisionEventId: "evt_00000000000000000000000000000003",
    repositoryId: parent.repositoryId,
    workspaceId: parent.workspaceId,
    worktreeId: parent.worktreeId,
    correlationId: parent.correlationId,
    source: { kind: "core", sourceId: "source_core", instanceId: "22222222-2222-4222-8222-222222222222" },
    timestamp: parent.timestamp,
    sourceSequenceStart: 0,
    detector: { detectorId: "detector_stale-read", version: "1" },
    policy: { policyId: "policy_report-only", version: "1" },
  });
  const store = SqliteEventStore.open(":memory:");
  try {
    store.append(parent);
    store.append(records.finding);
    store.append(records.decision);

    assert.deepEqual(store.read().map((event) => event.eventType), ["tool.requested", "finding.created", "decision.created"]);
    assert.equal(records.decision.payload.decision.coordinationAction, "request_revalidation");
    assert.equal(records.decision.payload.decision.gatewayDirective, "allow_with_notice");
  } finally {
    store.close();
  }
});
