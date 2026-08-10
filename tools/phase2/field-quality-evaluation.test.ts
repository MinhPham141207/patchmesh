import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateFieldCorpus } from "./field-quality-evaluation.js";
import type { FieldCorpus } from "./field-corpus.js";

const digest = `sha256:${"b".repeat(64)}` as const;

test("field evaluator reports metrics only from reviewed detector cases", () => {
  const cases = ["same_symbol_overlap", "stale_read_before_write", "exported_contract_invalidation"].map((detector, index) => ({
    caseId: `field-${index}-aaa`,
    caseKind: "detector_quality" as const,
    tracePaths: [".evidence/trace/run_parent.jsonl"],
    scenario: "reviewed detector case",
    detector: detector as "same_symbol_overlap" | "stale_read_before_write" | "exported_contract_invalidation",
    expectedFinding: true,
    observedFinding: true,
    confidence: 0.99,
    reviewerId: "reviewer-a",
    reviewedAt: "2026-08-10T09:00:00.000Z",
    coverage: "sufficient" as const,
    limitations: [],
    replayDigest: digest,
    detectorOutputPath: ".evidence/field-output/reviewed-detector-case.json",
    detectorOutputDigest: digest,
    holdout: true,
  }));
  const result = evaluateFieldCorpus({ schemaVersion: 1, corpusVersion: "field-v1", evidenceKind: "field_review", cases });
  assert.equal(result.status, "insufficient_field_cases");
  assert.equal(result.metrics.every((metric) => metric.caseCount === 1), true);
});

test("calibrates confidence against reviewed expected labels", () => {
  const cases = Array.from({ length: 20 }, (_, index) => ({
    caseId: `calibration-${index.toString().padStart(3, "0")}`,
    caseKind: "detector_quality" as const,
    tracePaths: [".evidence/trace/run_parent.jsonl"],
    scenario: "reviewed detector case",
    detector: "same_symbol_overlap" as const,
    expectedFinding: index < 10,
    observedFinding: true,
    confidence: 0.99,
    reviewerId: "reviewer-a",
    reviewedAt: "2026-08-10T09:00:00.000Z",
    coverage: "sufficient" as const,
    limitations: [],
    replayDigest: digest,
    detectorOutputPath: ".evidence/field-output/reviewed-detector-case.json",
    detectorOutputDigest: digest,
    holdout: true,
  }));
  const result = evaluateFieldCorpus({ schemaVersion: 1, corpusVersion: "field-v1", evidenceKind: "field_review", cases });
  assert.ok(Math.abs((result.metrics[0]?.brierScore ?? 0) - 0.4901) < 1e-12);
});
