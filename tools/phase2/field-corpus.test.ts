import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateFieldCorpus } from "./field-quality-evaluation.js";
import { loadFieldCorpus, validateFieldCorpus, type FieldCorpus } from "./field-corpus.js";

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
    detectorOutputPath: ".evidence/field-output/quality-case.json",
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
    cases: [qualityCase({ caseId: "trace-case-aaa", caseKind: "trace_integrity", detector: null, expectedFinding: null, observedFinding: null, confidence: null, coverage: "unknown", detectorOutputPath: null, detectorOutputDigest: null })],
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
  assert.equal(diagnostics.some((diagnostic) => /sufficient coverage/.test(diagnostic)), true);
});

test("requires reviewed detector-quality cases to be holdouts with a persisted output artifact", () => {
  const diagnostics = validateFieldCorpus({
    schemaVersion: 1,
    corpusVersion: "field-v1",
    evidenceKind: "field_review",
    cases: [qualityCase({ holdout: false, detectorOutputPath: null })],
  });
  assert.equal(diagnostics.some((diagnostic) => /reviewed holdouts/.test(diagnostic)), true);
  assert.equal(diagnostics.some((diagnostic) => /detector output/.test(diagnostic)), true);
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const validTraceEvent = {
  schemaVersion: 1, eventId: "trace_event_1", runId: "run-a", sequence: 1, timestamp: "2026-08-10T00:00:00.000Z",
  agentId: "agent-a", taskId: "task-a", worktreeId: "worktree-a", toolCallId: "tool-1", parentRunId: null, parentTaskId: null,
  action: "tool.completed", paths: [], resources: [],
  result: { status: "succeeded", durationMs: 1, exitCode: 0, errorClass: null, outputDigest: null, redactionCount: 0 },
  derivedEffect: { status: "unknown", changedPaths: [], resourceChanges: [], confidence: 0, gaps: ["unavailable"] },
};

test("rejects detector-quality artifacts whose content does not bind to the reviewed labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchmesh-field-corpus-"));
  try {
    await mkdir(join(root, ".evidence", "trace"), { recursive: true });
    await mkdir(join(root, ".evidence", "runs"), { recursive: true });
    await mkdir(join(root, ".evidence", "field-output"), { recursive: true });
    await writeFile(join(root, ".evidence", "trace", "run-a.jsonl"), `${JSON.stringify(validTraceEvent)}\n`, "utf8");
    await writeFile(join(root, ".evidence", "runs", "run-a.manifest.json"), JSON.stringify({ schemaVersion: 1, recorderVersion: "0.1.0", runId: "run-a", startedAt: "2026-08-10T00:00:00.000Z", eventCount: 1, errors: [], gaps: [], traceDigest: sha256(canonicalJson([validTraceEvent])) }), "utf8");
    const output = JSON.stringify({ detector: "same_symbol_overlap", expectedFinding: false, observedFinding: true, confidence: 0.99 });
    await writeFile(join(root, ".evidence", "field-output", "quality-case.json"), output, "utf8");
    const corpus: FieldCorpus = { schemaVersion: 1, corpusVersion: "field-v1", evidenceKind: "field_review", cases: [qualityCase({ tracePaths: [".evidence/trace/run-a.jsonl"], holdout: true, replayDigest: sha256(canonicalJson([{ tracePath: ".evidence/trace/run-a.jsonl", digest: sha256(canonicalJson([validTraceEvent])) }])), detectorOutputDigest: sha256(output) })] };
    const corpusPath = join(root, "field-corpus.json");
    await writeFile(corpusPath, JSON.stringify(corpus), "utf8");
    await assert.rejects(loadFieldCorpus(corpusPath, root), /detector output does not match reviewed detector labels/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects trace artifacts that only parse but fail the evidence trace validator", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchmesh-field-corpus-"));
  try {
    await mkdir(join(root, ".evidence", "trace"), { recursive: true });
    await mkdir(join(root, ".evidence", "runs"), { recursive: true });
    await writeFile(join(root, ".evidence", "trace", "run-a.jsonl"), "{}\n", "utf8");
    await writeFile(join(root, ".evidence", "runs", "run-a.manifest.json"), JSON.stringify({}), "utf8");
    const corpusPath = join(root, "field-corpus.json");
    await writeFile(corpusPath, JSON.stringify({ schemaVersion: 1, corpusVersion: "field-v1", evidenceKind: "field_review", cases: [qualityCase({ tracePaths: [".evidence/trace/run-a.jsonl"], caseKind: "trace_integrity", detector: null, expectedFinding: null, observedFinding: null, confidence: null, coverage: "unknown", detectorOutputPath: null, detectorOutputDigest: null })] }), "utf8");
    await assert.rejects(loadFieldCorpus(corpusPath, root), /TRACE_SCHEMA_VERSION_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
