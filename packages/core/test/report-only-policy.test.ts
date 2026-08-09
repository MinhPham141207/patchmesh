import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateReportOnlyPolicy,
  type DetectorFinding,
} from "../src/index.js";

const finding = (
  findingType: DetectorFinding["findingType"],
  confidence: number,
): DetectorFinding => ({
  findingType,
  confidence,
  reason: "fixture",
  evidence: {
    subjectResourceId: `res_${"e".repeat(64)}`,
    affectedTaskId: "task_a",
    dependencyIds: [],
    evidenceEventIds: ["evt_00000000000000000000000000000001"],
    coverageIds: ["coverage_policy"],
  },
});

test("keeps low-confidence findings as allow-and-record", () => {
  assert.deepEqual(
    evaluateReportOnlyPolicy({ finding: finding("same_symbol_overlap", 0.49), affectedTaskCompleted: false }),
    {
      findingType: "same_symbol_overlap",
      targetTaskId: "task_a",
      action: "record",
      gatewayDirective: "allow",
    },
  );
});

test("requests revalidation without executing or blocking completed stale work", () => {
  const result = evaluateReportOnlyPolicy({
    finding: finding("stale_read_before_write", 0.95),
    affectedTaskCompleted: true,
  });

  assert.equal(result.action, "request_revalidation");
  assert.equal(result.gatewayDirective, "allow_with_notice");
});
