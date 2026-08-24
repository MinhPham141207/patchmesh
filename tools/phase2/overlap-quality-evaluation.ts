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
 * Scores the file-level contention rule against real recorded working patterns.
 *
 * This is the counterpart to `detector-quality-evaluation.ts` and differs from it in the one
 * way that matters: that corpus is synthetic and labeled `advisoryOnly`, while every case here
 * is a row this repository's own ledger actually produced. It is still a **single repository
 * and a single developer**, so it is field evidence rather than field *validation* -- enough to
 * catch a rule that reports popularity instead of contention, not enough to publish a precision
 * figure for other people's workloads.
 *
 * Why it exists: `findOverlappingWork` is the only detector that fires on hook-recorded data,
 * and it was the only one with no gate. Before the contention rule it returned 20 files on this
 * ledger, of which 13 were sequential edits by workers who had each finished before the next
 * began -- a precision of roughly 0.35 against these labels. The gate below is what stops that
 * regressing silently, and it is the precondition the delivery plan's S5 sets before any of
 * this may be spent on an agent's context unasked.
 */

/**
 * Deliberately stricter on precision than the synthetic gate and far more forgiving on recall.
 *
 * An advisory that will one day interrupt an agent mid-task is judged by how often it is
 * *wrong*, not by how much it catches: a missed collision costs what it would have cost anyway,
 * while a false one costs the reader's attention and teaches them to stop reading. The rule is
 * deliberately conservative and can only miss contention, never invent it, so recall is where
 * the slack belongs.
 */
export const overlapQualityThresholds = {
  minimumPrecision: 1.0,
  minimumRecall: 0.80,
  maximumBrierScore: 0.10,
  maximumFalsePositiveRate: 0.0,
} as const;

/**
 * How sure the finding is of the thing it actually claims.
 *
 * The claim is "two workers were in flight over this file", which is observed rather than
 * predicted, so this is high. It is deliberately not 1.0: the binding that produced each change
 * is itself an mtime-window inference, and a change bound to the wrong call would put the wrong
 * worker in the pair. It is emphatically *not* a probability that the two edits conflict --
 * the ledger holds paths and hashes, not intent, and nothing here knows whether the work
 * diverged.
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
  /** Real recorded rows, but one repository and one developer. Not a published precision figure. */
  readonly evidenceKind: "field_single_repository";
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
    evidenceKind: "field_single_repository",
    accepted: gate.accepted,
    gate,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evaluation = evaluateOverlapQuality();
  console.log(JSON.stringify(evaluation, null, 2));
  if (!evaluation.accepted) process.exitCode = 1;
}
