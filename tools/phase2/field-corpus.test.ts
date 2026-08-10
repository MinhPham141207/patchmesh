import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateFieldCorpus } from "./field-quality-evaluation.js";
import { validateFieldCorpus, type FieldCorpus } from "./field-corpus.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function qualityCase(overrides: Partial<FieldCorpus["cases"][number]> = {}): FieldCorpus["cases"][number] {
  return {
    caseId: "quality-case-aaa",
    caseKind: "detector_quality",
    tracePaths: [".evidence/trace/run_parent.jsonl"],
    scenario: "reviewed detector case",
    detector: "same_symbol_overlap",
    expectedFinding: true,
    observedFinding: true,
    confidence: 0.99,
    reviewerId: "reviewer-a",
    reviewedAt: "2026-08-10T09:00:00.000Z",
    coverage: "sufficient",
    limitations: [],
    replayDigest: digest,
    detectorOutputDigest: digest,
    holdout: false,
    ...overrides,
  };
}

test("accepts trace-integrity cases without detector labels", () => {
  const corpus: FieldCorpus = {
    schemaVersion: 1,
    corpusVersion: "field-v1",
    evidenceKind: "field_review",
    cases: [qualityCase({ caseId: "trace-case-aaa", caseKind: "trace_integrity", detector: null, expectedFinding: null, observedFinding: null, confidence: null, coverage: "unknown", detectorOutputDigest: null })],
  };
  assert.deepEqual(validateFieldCorpus(corpus), []);
});

test("rejects detector labels without sufficient observed coverage", () => {
  const diagnostics = validateFieldCorpus({
    schemaVersion: 1,
    corpusVersion: "field-v1",
    evidenceKind: "field_review",
    cases: [qualityCase({ coverage: "unknown" })],
  });
  assert.match(diagnostics[0] ?? "", /sufficient coverage/);
});

test("does not accept a corpus with no real detector cases", () => {
  const result = evaluateFieldCorpus({
    schemaVersion: 1,
    corpusVersion: "field-v1",
    evidenceKind: "field_review",
    cases: [],
  });
  assert.equal(result.status, "insufficient_field_cases");
  assert.equal(result.accepted, false);
});
