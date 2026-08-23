import assert from "node:assert/strict";
import { test } from "node:test";

import { overlapCorpus } from "./overlap-corpus.js";
import { evaluateOverlapQuality, overlapQualityThresholds } from "./overlap-quality-evaluation.js";

test("the contention rule holds its field gate: every positive caught, nothing invented", () => {
  const result = evaluateOverlapQuality();

  // Pinned so a threshold cannot be quietly relaxed to make a regression pass.
  assert.deepEqual(overlapQualityThresholds, {
    minimumPrecision: 1.0,
    minimumRecall: 0.80,
    maximumBrierScore: 0.10,
    maximumFalsePositiveRate: 0.0,
  });
  assert.equal(result.evidenceKind, "field_single_repository");
  assert.equal(result.accepted, true);
  assert.deepEqual(result.gate.failedMeasures, []);
  // A false positive is the failure that matters: this will one day interrupt an agent.
  assert.equal(result.gate.metrics.falsePositive, 0);
});

test("the corpus is labeled in both directions, or it proves nothing", () => {
  // A corpus of only positives cannot catch a rule that says yes to everything, which is
  // exactly the rule this replaced.
  assert.equal(overlapCorpus.some((entry) => entry.expectedContention), true);
  assert.equal(overlapCorpus.some((entry) => !entry.expectedContention), true);
  assert.equal(overlapCorpus.length >= 9, true);
  for (const entry of overlapCorpus) {
    assert.equal(entry.note.trim().length > 0, true, `${entry.caseId} must say why its label is right`);
    assert.equal(entry.tasks.length >= 2, true, `${entry.caseId} needs two writers to mean anything`);
  }
});

test("the corpus keys reach the rule, so a silent miss cannot read as a clean gate", () => {
  // The first run of this corpus scored precision 1.0 and recall 0.0 because the worker keys
  // were reconstructed by hand and the separator did not match: every lookup missed, so every
  // case came back negative and the gate reported no false positives. Perfect precision with
  // zero recall is the signature of a corpus that is not reaching the code at all.
  const result = evaluateOverlapQuality();
  assert.equal(result.gate.metrics.truePositive > 0, true, "at least one positive must actually fire");
});
