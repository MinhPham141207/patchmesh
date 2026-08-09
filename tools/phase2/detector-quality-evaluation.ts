import {
  evaluateDetectorQualityGate,
  measureDetectorQuality,
  type DetectorQualityGate,
} from "../../packages/core/dist/index.js";
import { pathToFileURL } from "node:url";
import type { FindingType } from "../../packages/protocol/dist/index.js";

import { syntheticDetectorQualityCorpus, syntheticDetectorQualityCorpusVersion } from "./detector-quality-corpus.js";

export const engineeringDetectorQualityThresholds = {
  minimumPrecision: 0.95,
  minimumRecall: 0.90,
  maximumBrierScore: 0.10,
  maximumFalsePositiveRate: 0.02,
} as const;

const findingTypes: readonly FindingType[] = [
  "same_symbol_overlap",
  "stale_read_before_write",
  "exported_contract_invalidation",
];

export interface SyntheticDetectorQualityEvaluation {
  readonly corpusVersion: string;
  readonly evidenceKind: "synthetic_engineering";
  readonly advisoryOnly: true;
  readonly accepted: boolean;
  readonly gates: readonly DetectorQualityGate[];
}

/** Runs the synthetic engineering corpus. This must never be reported as field validation. */
export function evaluateSyntheticDetectorQuality(): SyntheticDetectorQualityEvaluation {
  const gates = findingTypes.map((findingType) => evaluateDetectorQualityGate(
    measureDetectorQuality(findingType, syntheticDetectorQualityCorpus),
    engineeringDetectorQualityThresholds,
  ));
  return {
    corpusVersion: syntheticDetectorQualityCorpusVersion,
    evidenceKind: "synthetic_engineering",
    advisoryOnly: true,
    accepted: gates.every((gate) => gate.accepted),
    gates,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evaluation = evaluateSyntheticDetectorQuality();
  console.log(JSON.stringify(evaluation, null, 2));
  if (!evaluation.accepted) process.exitCode = 1;
}
