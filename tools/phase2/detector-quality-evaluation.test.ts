import assert from "node:assert/strict";
import { test } from "node:test";

import { syntheticDetectorQualityCorpus } from "./detector-quality-corpus.js";
import { engineeringDetectorQualityThresholds, evaluateSyntheticDetectorQuality } from "./detector-quality-evaluation.js";

test("M7 synthetic corpus is labeled for every detector and passes the unchanged engineering gate", () => {
  const result = evaluateSyntheticDetectorQuality();
  assert.deepEqual(engineeringDetectorQualityThresholds, {
    minimumPrecision: 0.95,
    minimumRecall: 0.90,
    maximumBrierScore: 0.10,
    maximumFalsePositiveRate: 0.02,
  });
  assert.equal(result.evidenceKind, "synthetic_engineering");
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.accepted, true);
  assert.equal(syntheticDetectorQualityCorpus.length, 15);
  for (const gate of result.gates) {
    const cases = syntheticDetectorQualityCorpus.filter((entry) => entry.findingType === gate.metrics.findingType);
    assert.equal(cases.some((entry) => entry.expectedFinding), true);
    assert.equal(cases.some((entry) => !entry.expectedFinding), true);
    assert.equal(gate.accepted, true);
  }
});
