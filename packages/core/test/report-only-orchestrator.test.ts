import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createReportOnlyOrchestrationRecords,
  type DetectorFinding,
} from "../src/index.js";

function finding(suffix: string, type: DetectorFinding["findingType"]): DetectorFinding {
  return {
    findingType: type,
    confidence: 0.95,
    reason: `finding ${suffix}`,
    evidence: {
      subjectResourceId: `res_${suffix.repeat(64)}`,
      affectedTaskId: `task_${suffix}`,
      dependencyIds: [`dep_${suffix}`],
      evidenceEventIds: [`evt_${suffix.repeat(32)}`],
      coverageIds: [`coverage_${suffix}`],
    },
  };
}

const context = {
  eventIds: [
    { findingEventId: "evt_00000000000000000000000000000003", decisionEventId: "evt_00000000000000000000000000000004" },
    { findingEventId: "evt_00000000000000000000000000000005", decisionEventId: "evt_00000000000000000000000000000006" },
  ],
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_11111111-1111-4111-8111-111111111111",
  worktreeId: "wt_11111111-1111-4111-8111-111111111111",
  correlationId: "corr_00000000000000000000000000000001",
  source: { kind: "core" as const, sourceId: "source_core", instanceId: "11111111-1111-4111-8111-111111111111" },
  timestamp: "2026-08-09T00:00:00.000Z",
  sourceSequenceStart: 10,
  detector: { detectorId: "detector_phase2", version: "1" },
  policy: { policyId: "policy_report-only", version: "1" },
  affectedTaskCompleted: () => true,
};

test("orchestrates stable report-only records with causal decisions", () => {
  const stale = finding("a", "stale_read_before_write");
  const overlap = finding("b", "same_symbol_overlap");
  const first = createReportOnlyOrchestrationRecords([stale, overlap], context);
  const second = createReportOnlyOrchestrationRecords([overlap, stale], context);

  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  for (const record of first) {
    assert.equal(record.decision.causationId, record.finding.eventId);
    assert.equal(record.decision.payload.decision.gatewayDirective === "allow" || record.decision.payload.decision.gatewayDirective === "allow_with_notice", true);
  }
  assert.equal(first.some((record) => record.decision.payload.decision.coordinationAction === "request_revalidation"), true);
});

test("requires a durable event pair for every finding", () => {
  assert.throws(() => createReportOnlyOrchestrationRecords([finding("a", "same_symbol_overlap")], { ...context, eventIds: [] }));
});
