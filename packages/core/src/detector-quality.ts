import type { FindingType } from "patchmesh-protocol";

import type { DetectorFinding } from "./types.js";

export interface DetectorCorpusCase {
  readonly caseId: string;
  readonly findingType: FindingType;
  readonly expectedFinding: boolean;
  readonly actualFinding: DetectorFinding | null;
}

export interface DetectorQualityThresholds {
  readonly minimumPrecision: number;
  readonly minimumRecall: number;
  readonly maximumBrierScore: number;
  readonly maximumFalsePositiveRate: number;
}

export interface DetectorQualityMetrics {
  readonly findingType: FindingType;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly trueNegative: number;
  readonly falseNegative: number;
  readonly precision: number;
  readonly recall: number;
  readonly brierScore: number;
  readonly falsePositiveRate: number;
}

export interface DetectorQualityGate {
  readonly metrics: DetectorQualityMetrics;
  readonly thresholds: DetectorQualityThresholds;
  readonly accepted: boolean;
  readonly failedMeasures: readonly (keyof DetectorQualityThresholds)[];
}

function ratio(numerator: number, denominator: number, emptyValue: number): number {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function validThreshold(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Measures a single detector against a labeled corpus without side effects. */
export function measureDetectorQuality(
  findingType: FindingType,
  cases: readonly DetectorCorpusCase[],
): DetectorQualityMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let brierTotal = 0;
  for (const entry of cases) {
    if (entry.findingType !== findingType) continue;
    const predicted = entry.actualFinding !== null;
    const actual = entry.expectedFinding;
    if (predicted && actual) truePositive += 1;
    else if (predicted) falsePositive += 1;
    else if (actual) falseNegative += 1;
    else trueNegative += 1;
    const confidence = entry.actualFinding?.confidence ?? 0;
    brierTotal += (confidence - (actual ? 1 : 0)) ** 2;
  }
  const count = truePositive + falsePositive + trueNegative + falseNegative;
  return {
    findingType,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    precision: ratio(truePositive, truePositive + falsePositive, 1),
    recall: ratio(truePositive, truePositive + falseNegative, 1),
    brierScore: ratio(brierTotal, count, 0),
    falsePositiveRate: ratio(falsePositive, falsePositive + trueNegative, 0),
  };
}

/** Applies approved numeric thresholds and makes any failed measure explicit. */
export function evaluateDetectorQualityGate(
  metrics: DetectorQualityMetrics,
  thresholds: DetectorQualityThresholds,
): DetectorQualityGate {
  if (!Object.values(thresholds).every(validThreshold)) {
    throw new Error("detector quality thresholds must be finite values between zero and one");
  }
  const failedMeasures: Array<keyof DetectorQualityThresholds> = [];
  if (metrics.precision < thresholds.minimumPrecision) failedMeasures.push("minimumPrecision");
  if (metrics.recall < thresholds.minimumRecall) failedMeasures.push("minimumRecall");
  if (metrics.brierScore > thresholds.maximumBrierScore) failedMeasures.push("maximumBrierScore");
  if (metrics.falsePositiveRate > thresholds.maximumFalsePositiveRate) failedMeasures.push("maximumFalsePositiveRate");
  return { metrics, thresholds, accepted: failedMeasures.length === 0, failedMeasures };
}
