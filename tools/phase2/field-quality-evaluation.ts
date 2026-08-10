import { pathToFileURL } from "node:url";
import { loadFieldCorpus, type FieldCorpus, type FieldDetector } from "./field-corpus.js";

export interface FieldDetectorMetrics {
  readonly detector: FieldDetector;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly trueNegative: number;
  readonly falseNegative: number;
  readonly precision: number;
  readonly recall: number;
  readonly brierScore: number;
  readonly falsePositiveRate: number;
  readonly caseCount: number;
}

export interface FieldQualityEvaluation {
  readonly corpusVersion: string;
  readonly evidenceKind: "field_review";
  readonly accepted: boolean;
  readonly status: "accepted" | "rejected" | "insufficient_field_cases";
  readonly metrics: readonly FieldDetectorMetrics[];
}

const detectors: readonly FieldDetector[] = [
  "same_symbol_overlap",
  "stale_read_before_write",
  "exported_contract_invalidation",
];

function metricsFor(corpus: FieldCorpus, detector: FieldDetector): FieldDetectorMetrics {
  const cases = corpus.cases.filter((entry) => entry.caseKind === "detector_quality" && entry.detector === detector && entry.holdout);
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let brierScore = 0;
  for (const entry of cases) {
    if (entry.expectedFinding === true && entry.observedFinding === true) truePositive += 1;
    if (entry.expectedFinding === false && entry.observedFinding === true) falsePositive += 1;
    if (entry.expectedFinding === false && entry.observedFinding === false) trueNegative += 1;
    if (entry.expectedFinding === true && entry.observedFinding === false) falseNegative += 1;
    brierScore += (Number(entry.observedFinding) - (entry.confidence ?? 0)) ** 2;
  }
  const actualPositive = truePositive + falseNegative;
  const actualNegative = trueNegative + falsePositive;
  return {
    detector,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    precision: truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive),
    recall: actualPositive === 0 ? 0 : truePositive / actualPositive,
    brierScore: cases.length === 0 ? 0 : brierScore / cases.length,
    falsePositiveRate: actualNegative === 0 ? 0 : falsePositive / actualNegative,
    caseCount: cases.length,
  };
}

export function evaluateFieldCorpus(corpus: FieldCorpus): FieldQualityEvaluation {
  const metrics = detectors.map((detector) => metricsFor(corpus, detector));
  const enoughCases = metrics.every((metric) => metric.caseCount > 0);
  const accepted = enoughCases && metrics.every((metric) =>
    metric.precision >= 0.95 && metric.recall >= 0.9 && metric.brierScore <= 0.1 && metric.falsePositiveRate <= 0.02);
  return {
    corpusVersion: corpus.corpusVersion,
    evidenceKind: "field_review",
    accepted,
    status: !enoughCases ? "insufficient_field_cases" : accepted ? "accepted" : "rejected",
    metrics,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const corpus = await loadFieldCorpus(process.argv[2] ?? "tools/phase2/field-corpus.json");
  console.log(JSON.stringify(evaluateFieldCorpus(corpus), null, 2));
  if (!evaluateFieldCorpus(corpus).accepted) process.exitCode = 2;
}
