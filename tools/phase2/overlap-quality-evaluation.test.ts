import assert from "node:assert/strict";
import { test } from "node:test";

import { contentionAmong, workerKey } from "patchmesh-query";
import type { OverlappingTask, WorkerActivity } from "patchmesh-query";

import { detectorBehaviorRegressionCases, overlapCorpus } from "./overlap-corpus.js";
import { evaluateOverlapQuality, overlapQualityThresholds } from "./overlap-quality-evaluation.js";

test("the contention rule's honest field gate: n=8, precision 0.667, recall 1.0", () => {
  const result = evaluateOverlapQuality();

  // Pinned so a threshold cannot be quietly relaxed to make a regression pass, and so a real
  // improvement (or regression) in the underlying rule shows up as a changed number here rather
  // than as a silently-adjusted threshold.
  assert.deepEqual(overlapQualityThresholds, {
    minimumPrecision: 0.60,
    minimumRecall: 0.90,
    maximumBrierScore: 0.15,
    maximumFalsePositiveRate: 0.25,
  });
  assert.equal(result.evidenceKind, "field_hash_verified_single_repository");

  // The honest numbers, pinned exactly. Precision is 2/3, not 1.0 -- see
  // outcome-cli-test-two-sessions in overlap-corpus.ts for the one verified false positive.
  assert.equal(result.gate.metrics.truePositive, 2);
  assert.equal(result.gate.metrics.falsePositive, 1);
  assert.equal(result.gate.metrics.trueNegative, 5);
  assert.equal(result.gate.metrics.falseNegative, 0);
  assert.equal(result.gate.metrics.precision, 2 / 3);
  assert.equal(result.gate.metrics.recall, 1);
  assert.equal(result.gate.metrics.falsePositiveRate, 1 / 6);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.gate.failedMeasures, []);
});

test("the outcome corpus is labeled from content hashes, not from contentionAmong's own rule", () => {
  // Every case must carry the independent evidence its label was derived from -- a corpus that
  // asserts a label without the hashes that produced it is exactly the thing this rewrite exists
  // to stop, per this repo's convention that a finding carries the evidence for its claim.
  for (const entry of overlapCorpus) {
    assert.equal(entry.outcome.earlierAfterHash.length, 64, `${entry.caseId} needs a real digest`);
    assert.equal(entry.outcome.laterBeforeHash.length, 64, `${entry.caseId} needs a real digest`);
    // The label must actually match what the hashes say: chainMatches means the later write
    // built on exactly the earlier write's output, which is the outcome definition of "not
    // interference" -- so expectedContention is the negation of chainMatches, always.
    assert.equal(
      entry.expectedContention,
      !entry.outcome.chainMatches,
      `${entry.caseId}'s label must follow from its own hash comparison`,
    );
    assert.equal(entry.note.trim().length > 0, true, `${entry.caseId} must say why its label is right`);
    assert.equal(entry.tasks.length >= 2, true, `${entry.caseId} needs two writers to mean anything`);
  }
  assert.equal(overlapCorpus.some((entry) => entry.expectedContention), true);
  assert.equal(overlapCorpus.some((entry) => !entry.expectedContention), true);
});

test("the detector and the outcome corpus disagree exactly once, and it is documented", () => {
  // This is the point of the whole rewrite: a corpus that can only ever agree with the code it
  // scores is not measuring anything. Pin the one place they diverge so it cannot regress into
  // silent agreement (which would mean the disagreement was quietly "fixed" by relabeling rather
  // than by fixing or accepting the detector's rule -- packages/query/src/overlap.ts is out of
  // scope for this pass).
  const disagreements = overlapCorpus.filter((entry) => {
    const contention = contentionAmong(entry.tasks, entry.activityByWorker);
    const detectorSaysContention = contention !== null;
    return detectorSaysContention !== entry.expectedContention;
  });
  assert.deepEqual(disagreements.map((entry) => entry.caseId), ["outcome-cli-test-two-sessions"]);
});

test("the corpus keys reach the rule, so a silent miss cannot read as a clean gate", () => {
  // The first run of the field-v2 corpus scored precision 1.0 and recall 0.0 because the worker
  // keys were reconstructed by hand and the separator did not match: every lookup missed, so
  // every case came back negative and the gate reported no false positives. Perfect precision
  // with zero recall is the signature of a corpus that is not reaching the code at all.
  const result = evaluateOverlapQuality();
  assert.equal(result.gate.metrics.truePositive > 0, true, "at least one positive must actually fire");
});

test("the detector behavior regression cases are not field evidence and are not in the gate", () => {
  // These pin contentionAmong's specified behavior at boundaries with no real second write to
  // hash-check -- real regression value, but not a measurement of whether the rule is right.
  // Folding them into the field corpus is exactly what made field-v2 look more validated than it
  // was, so this asserts the split holds.
  const overlapCorpusIds = new Set(overlapCorpus.map((entry) => entry.caseId));
  for (const entry of detectorBehaviorRegressionCases) {
    assert.equal(overlapCorpusIds.has(entry.caseId), false, `${entry.caseId} must not double as field evidence`);
  }
  assert.equal(detectorBehaviorRegressionCases.length >= 4, true);
});

test("field-v1's superseded session-span rule fails the boundary regression cases", () => {
  // `field-v1`'s rule -- "the earlier worker's session ended after the later write" -- is
  // reimplemented here and run over the constructed boundary shapes. It must produce at least
  // one false positive, because a corpus a wrong rule passes is not measuring the rule.
  const supersededRule = (
    tasks: readonly OverlappingTask[],
    activityByWorker: ReadonlyMap<string, WorkerActivity>,
  ): boolean => {
    const ordered = [...tasks]
      .filter((task) => task.agentId !== null || task.worktreeId !== null)
      .sort((left, right) => left.at.localeCompare(right.at));
    for (let index = 0; index < ordered.length; index += 1) {
      const earlier = ordered[index]!;
      const worker = workerKey(earlier.agentId, earlier.worktreeId);
      const activity = activityByWorker.get(worker);
      if (activity === undefined || activity.length === 0) continue;
      const lastActive = activity[activity.length - 1]!;
      for (let other = index + 1; other < ordered.length; other += 1) {
        const later = ordered[other]!;
        if (workerKey(later.agentId, later.worktreeId) === worker) continue;
        if (lastActive > later.at) return true;
      }
    }
    return false;
  };

  const falsePositives = detectorBehaviorRegressionCases.filter(
    (entry) => !entry.expectedContention && supersededRule(entry.tasks, entry.activityByWorker),
  );
  assert.ok(
    falsePositives.length > 0,
    "the superseded session-span rule must fail these cases; if it passes, they are not discriminating",
  );

  // And the rule actually shipped must get those very cases right.
  for (const entry of falsePositives) {
    assert.equal(
      contentionAmong(entry.tasks, entry.activityByWorker),
      null,
      `${entry.caseId} separates the two rules and the current one must call it a negative`,
    );
  }
});
