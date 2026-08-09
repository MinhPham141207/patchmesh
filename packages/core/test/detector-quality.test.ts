import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateDetectorQualityGate,
  measureDetectorQuality,
  type DetectorCorpusCase,
} from "../src/index.js";

const detected = {
  findingType: "same_symbol_overlap" as const,
  confidence: 0.9,
  reason: "fixture",
  evidence: {
    subjectResourceId: `res_${"a".repeat(64)}`,
    affectedTaskId: "task_task-a",
    dependencyIds: [],
    evidenceEventIds: ["evt_00000000000000000000000000000001"],
    coverageIds: [`coverage_${"b".repeat(32)}`],
  },
};

test("measures a labeled detector corpus and accepts approved thresholds", () => {
  const cases: readonly DetectorCorpusCase[] = [
    { caseId: "positive", findingType: "same_symbol_overlap", expectedFinding: true, actualFinding: detected },
    { caseId: "negative", findingType: "same_symbol_overlap", expectedFinding: false, actualFinding: null },
  ];
  const metrics = measureDetectorQuality("same_symbol_overlap", cases);
  const gate = evaluateDetectorQualityGate(metrics, {
    minimumPrecision: 0.9,
    minimumRecall: 0.9,
    maximumBrierScore: 0.1,
    maximumFalsePositiveRate: 0.1,
  });

  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(gate.accepted, true);
  assert.deepEqual(gate.failedMeasures, []);
});

test("reports the exact threshold measure that rejects a corpus", () => {
  const metrics = measureDetectorQuality("same_symbol_overlap", [{
    caseId: "false-positive",
    findingType: "same_symbol_overlap",
    expectedFinding: false,
    actualFinding: detected,
  }]);
  const gate = evaluateDetectorQualityGate(metrics, {
    minimumPrecision: 0.5,
    minimumRecall: 0,
    maximumBrierScore: 1,
    maximumFalsePositiveRate: 0.1,
  });

  assert.equal(gate.accepted, false);
  assert.deepEqual(gate.failedMeasures, ["minimumPrecision", "maximumFalsePositiveRate"]);
});
