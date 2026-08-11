import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadM0GateDefinition } from "./gate-definitions.js";
import { verifyM0Artifact } from "./m0-verify.js";

const root = resolve(import.meta.dirname, "../..");

test("verifier executes the checked-in schema before semantic recomputation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchmesh-m0-verify-schema-"));
  try {
    const [definition, definitionDigest] = await loadM0GateDefinition(root);
    const sample = { baselineNs: 10, instrumentedNs: 20, overheadNs: 10, failure: null };
    const commit = "1".repeat(40);
    const artifact = {
      schemaVersion: 1,
      evidenceKind: "m0_interception_budget",
      definitionVersion: definition.definitionVersion,
      definitionDigest,
      generatedAt: "2026-08-12T00:00:00.000Z",
      commit,
      gitDirty: false,
      environment: {
        timestamp: "2026-08-12T00:00:00.000Z", commit, dirty: false, os: "test-os", osRelease: "1", architecture: "x64",
        cpu: "test-cpu", memoryBytes: 1, nodeVersion: "v24", pnpmVersion: "11", workloadDefinitionDigest: definitionDigest,
      },
      workloads: definition.workloads.map((workload) => ({
        ...workload,
        coldInitializationMs: 1,
        coldInitializationRunsMs: [1, 1, 1],
        runs: Array.from({ length: 3 }, (_, index) => ({ runId: `run-${index + 1}`, warmupSamples: Array.from({ length: 5 }, () => sample), samples: Array.from({ length: 30 }, () => sample), p50Ms: null, p95Ms: null })),
        gateP95Ms: null,
        failures: 0,
        accepted: false,
      })),
      decision: "deferred",
      reason: "fixture",
      owner: "phase2-runtime",
      dueGate: "M0 controlled benchmark",
    };
    const path = join(directory, "valid.json");
    await writeFile(path, JSON.stringify(artifact), "utf8");
    const result = await verifyM0Artifact(path, root);
    assert.equal(result.outcome, "deferred", result.diagnostics.join("; "));
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.includes("schema")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verifier rejects an artifact that cannot satisfy the raw M0 evidence schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchmesh-m0-verify-"));
  try {
    const artifact = join(directory, "invalid.json");
    await writeFile(artifact, JSON.stringify({ decision: "accepted" }), "utf8");
    const result = await verifyM0Artifact(artifact, root);
    assert.equal(result.outcome, "rejected");
    assert.match(result.diagnostics.join(" "), /M0 evidence schema/i);
    assert.match(result.diagnostics.join(" "), /required property/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verifier returns a typed rejection for malformed or unreadable JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchmesh-m0-verify-invalid-"));
  try {
    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "{not-json", "utf8");
    const malformedResult = await verifyM0Artifact(malformed, root);
    assert.equal(malformedResult.outcome, "rejected");
    assert.equal(malformedResult.diagnostics[0], "M0 evidence artifact could not be read as JSON");
    const missingResult = await verifyM0Artifact(join(directory, "missing.json"), root);
    assert.equal(missingResult.outcome, "rejected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
