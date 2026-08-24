import assert from "node:assert/strict";
import { test } from "node:test";

import { contentionAmong, workerKey } from "patchmesh-query";
import type { OverlappingTask, WorkerActivity } from "patchmesh-query";

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
  assert.equal(overlapCorpus.length >= 12, true);
  for (const entry of overlapCorpus) {
    assert.equal(entry.note.trim().length > 0, true, `${entry.caseId} must say why its label is right`);
    assert.equal(entry.tasks.length >= 2, true, `${entry.caseId} needs two writers to mean anything`);
  }
});

test("the corpus can fail a rule, which is the only reason its numbers mean anything", () => {
  // `field-v1` scored precision 1.0, and that number was a tautology: the labels were assigned
  // by asking the question the detector asks, so the corpus could only ever confirm that the
  // code implements the rule. Nothing in it could distinguish a good rule from a bad one.
  //
  // This pins the fix. `field-v1`'s rule -- "the earlier worker's session ended after the later
  // write" -- is reimplemented here and run over the same cases. It must produce at least one
  // false positive, because a corpus a wrong rule passes is not measuring the rule.
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

  const falsePositives = overlapCorpus.filter(
    (entry) => !entry.expectedContention && supersededRule(entry.tasks, entry.activityByWorker),
  );
  assert.ok(
    falsePositives.length > 0,
    "the superseded session-span rule must fail this corpus; if it passes, the corpus is not discriminating",
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

test("the corpus keys reach the rule, so a silent miss cannot read as a clean gate", () => {
  // The first run of this corpus scored precision 1.0 and recall 0.0 because the worker keys
  // were reconstructed by hand and the separator did not match: every lookup missed, so every
  // case came back negative and the gate reported no false positives. Perfect precision with
  // zero recall is the signature of a corpus that is not reaching the code at all.
  const result = evaluateOverlapQuality();
  assert.equal(result.gate.metrics.truePositive > 0, true, "at least one positive must actually fire");
});
