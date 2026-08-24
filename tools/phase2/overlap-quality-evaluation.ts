import { pathToFileURL } from "node:url";
import {
  evaluateDetectorQualityGate,
  measureDetectorQuality,
  type DetectorCorpusCase,
  type DetectorQualityGate,
} from "patchmesh-core";
import { contentionAmong } from "patchmesh-query";

import { overlapCorpus, overlapCorpusVersion } from "./overlap-corpus.js";

/**
 * Scores the file-level contention rule against outcomes verified from content hashes.
 *
 * This is the counterpart to `detector-quality-evaluation.ts` and differs from it in the one way
 * that matters: that corpus is synthetic and labeled `advisoryOnly`, while every case here is a
 * row this repository's own ledger actually produced, labeled from a signal `contentionAmong`
 * does not read (see `overlap-corpus.ts`'s module doc for why the previous version's labels were
 * circular). It is still a **single repository, a single developer's session set, and n=8** --
 * enough to catch a rule that disagrees with verified outcomes, not enough to publish a
 * precision figure for other people's workloads.
 *
 * Why it exists: `findOverlappingWork` is the only detector that fires on hook-recorded data,
 * and it was the only one with no gate that measured anything but its own rule. The gate below
 * is what stops a real regression passing silently; it is not, and has never been, evidence that
 * the S5 field-validation bar is met.
 */

/**
 * Set from the honest n=8 measurement, not from the number the old circular corpus reported.
 *
 * Measured: precision 0.667 (2 true positive, 1 false positive), recall 1.0 (0 false negative),
 * false positive rate 0.167, Brier 0.104. `minimumPrecision` and `maximumFalsePositiveRate` sit
 * below/above the measured values with a little room, not at 1.0/0.0 -- this corpus is small
 * enough that one more hash-verified case in either direction would move the ratio, and a
 * threshold pinned exactly at today's number would either fail on the next honest case or have
 * to be "adjusted" to keep passing, which is the exact failure mode this rewrite exists to close
 * off. `minimumRecall` stays high because recall is genuinely where the rule is meant to be
 * generous (see `overlap.ts`'s own doc on being conservative). `maximumBrierScore` moves from
 * 0.10 to 0.15 because `OBSERVED_CONTENTION_CONFIDENCE` (0.9) now costs a real Brier penalty on
 * the one verified false positive; lowering the stated confidence to hide that would be tuning
 * the score, not fixing the instrument.
 */
export const overlapQualityThresholds = {
  minimumPrecision: 0.60,
  minimumRecall: 0.90,
  maximumBrierScore: 0.15,
  maximumFalsePositiveRate: 0.25,
} as const;

/**
 * How sure the finding is of the thing it actually claims.
 *
 * The claim is "two workers were in flight over this file", which is observed rather than
 * predicted, so this is high. It is deliberately not 1.0: the binding that produced each change
 * is itself an mtime-window inference, and a change bound to the wrong call would put the wrong
 * worker in the pair. It is emphatically *not* a probability that the two edits conflict -- and
 * `overlap-corpus.ts`'s hash-verified false positive (`outcome-cli-test-two-sessions`) is the
 * proof: this confidence is unchanged by whether the outcome corpus agrees.
 */
const OBSERVED_CONTENTION_CONFIDENCE = 0.9;

const SUBJECT_RESOURCE = `res_${"0".repeat(64)}`;

/** Map each labeled case through the real rule into the shape the shared gate scores. */
export function overlapCorpusCases(): readonly DetectorCorpusCase[] {
  return overlapCorpus.map((entry) => {
    const contention = contentionAmong(entry.tasks, entry.activityByWorker);
    return {
      caseId: entry.caseId,
      findingType: "concurrent_file_write",
      expectedFinding: entry.expectedContention,
      actualFinding: contention === null
        ? null
        : {
          findingType: "concurrent_file_write",
          evidence: {
            subjectResourceId: SUBJECT_RESOURCE,
            affectedTaskId: null,
            dependencyIds: [],
            evidenceEventIds: [],
            coverageIds: [],
          },
          confidence: OBSERVED_CONTENTION_CONFIDENCE,
          reason:
            `${contention.earlierWorkerAgentId ?? "an unattributed worker"} wrote at `
            + `${contention.earlierWriteAt} and was last seen `
            + `${contention.earlierWorkerIdleGapMs}ms before `
            + `${contention.laterWorkerAgentId ?? "another worker"} wrote at ${contention.laterWriteAt}`,
        },
    } as DetectorCorpusCase;
  });
}

export interface OverlapQualityEvaluation {
  readonly corpusVersion: string;
  /**
   * Real recorded rows labeled from an independent signal (content-hash outcomes), but one
   * repository, one developer's session set, and n=8. Not a published precision figure, and not
   * evidence the S5 field-validation bar is met.
   */
  readonly evidenceKind: "field_hash_verified_single_repository";
  readonly accepted: boolean;
  readonly gate: DetectorQualityGate;
}

export function evaluateOverlapQuality(): OverlapQualityEvaluation {
  const gate = evaluateDetectorQualityGate(
    measureDetectorQuality("concurrent_file_write", overlapCorpusCases()),
    overlapQualityThresholds,
  );
  return {
    corpusVersion: overlapCorpusVersion,
    evidenceKind: "field_hash_verified_single_repository",
    accepted: gate.accepted,
    gate,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evaluation = evaluateOverlapQuality();
  console.log(JSON.stringify(evaluation, null, 2));
  if (!evaluation.accepted) process.exitCode = 1;
}
