import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadM0GateDefinition } from "./gate-definitions.js";
import { verifyM0Evidence, type M0ExpectedEnvironment } from "./m0-evidence.js";

const root = resolve(import.meta.dirname, "../..");

async function evidence(): Promise<{ readonly definition: Awaited<ReturnType<typeof loadM0GateDefinition>>[0]; readonly digest: Awaited<ReturnType<typeof loadM0GateDefinition>>[1]; readonly value: Record<string, unknown> }> {
  const [definition, digest] = await loadM0GateDefinition(root);
  const sample = () => ({ baselineNs: 100, instrumentedNs: 1_000_100, overheadNs: 1_000_000, failure: null });
  return {
    definition,
    digest,
    value: {
      schemaVersion: 1, evidenceKind: "m0_interception_budget", definitionVersion: definition.definitionVersion, definitionDigest: digest,
      generatedAt: "2026-08-11T00:00:00.000Z", commit: "a".repeat(40), gitDirty: false,
      environment: { timestamp: "2026-08-11T00:00:00.000Z", commit: "a".repeat(40), dirty: false, os: "win32", osRelease: "10.0", architecture: "x64", cpu: "test-cpu", memoryBytes: 1, nodeVersion: "v24.0.0", pnpmVersion: "11.0.0", workloadDefinitionDigest: digest },
      workloads: definition.workloads.map((workload) => ({ workloadId: workload.workloadId, fileCount: workload.fileCount, budgetMs: workload.budgetMs, coldInitializationMs: 1, coldInitializationRunsMs: [1, 1, 1], runs: Array.from({ length: 3 }, (_, index) => ({ runId: `run-${index}`, warmupSamples: Array.from({ length: 5 }, sample), samples: Array.from({ length: 30 }, sample), p50Ms: 999, p95Ms: 999 })), gateP95Ms: 999, failures: 999, accepted: false })),
      decision: "rejected", reason: "forged fields are ignored", owner: null, dueGate: null,
    },
  };
}

function controlledEnvironment(overrides: Partial<M0ExpectedEnvironment> = {}): M0ExpectedEnvironment {
  return { os: "win32", osRelease: "10.0", architecture: "x64", cpu: "test-cpu", memoryBytes: 1, nodeVersion: "v24.0.0", pnpmVersion: "11.0.0", ...overrides };
}

test("accepts valid clean raw M0 evidence and ignores its asserted decision", async () => {
  const { definition, digest, value } = await evidence();
  const result = verifyM0Evidence(value, definition, digest, "a".repeat(40), controlledEnvironment());
  assert.equal(result.outcome, "accepted");
  assert.equal(result.workloads.every((workload) => workload.gateP95Ms === 1), true);
  assert.equal(result.workloads.every((workload) => workload.accepted), true);
  assert.equal(result.workloads.every((workload) => workload.runs.length === 3 && workload.runs.every((run) => run.p50Ms === 1 && run.p95Ms === 1)), true);
});

test("uses nearest-rank p95 boundary and defers only when two of thirty samples exceed budget", async () => {
  const { definition, digest, value } = await evidence();
  const workloads = value.workloads as Array<{ workloadId: string; runs: Array<{ samples: Array<Record<string, unknown>> }> }>;
  const small = workloads.find((workload) => workload.workloadId === "small")!;
  small.runs[0]!.samples[29]!.instrumentedNs = 300_000_100;
  small.runs[0]!.samples[29]!.overheadNs = 300_000_000;
  assert.equal(verifyM0Evidence(value, definition, digest, "a".repeat(40), controlledEnvironment()).outcome, "accepted");
  small.runs[0]!.samples[28]!.instrumentedNs = 300_000_100;
  small.runs[0]!.samples[28]!.overheadNs = 300_000_000;
  assert.equal(verifyM0Evidence(value, definition, digest, "a".repeat(40), controlledEnvironment()).outcome, "deferred");
});

test("rejects inconsistent timing samples", async () => {
  const { definition, digest, value } = await evidence();
  const workloads = value.workloads as Array<{ runs: Array<{ samples: Array<Record<string, unknown>> }> }>;
  workloads[0]!.runs[0]!.samples[0]!.overheadNs = 1;
  assert.equal(verifyM0Evidence(value, definition, digest).outcome, "rejected");
});

test("defers dirty, failed, and wrong-revision evidence without trusting its declared decision", async () => {
  const { definition, digest, value } = await evidence();
  value.gitDirty = true;
  (value.environment as Record<string, unknown>).dirty = true;
  const workloads = value.workloads as Array<{ runs: Array<{ warmupSamples: Array<Record<string, unknown>> }> }>;
  workloads[0]!.runs[0]!.warmupSamples[0]!.failure = { code: "CAPTURED_FAILURE", message: "captured failure" };
  const result = verifyM0Evidence(value, definition, digest, "b".repeat(40), controlledEnvironment());
  assert.equal(result.outcome, "deferred");
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.includes("dirty")), true);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.includes("failed")), true);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.includes("commit")), true);
});

test("rejects malformed counts and non-finite raw values", async () => {
  const { definition, digest, value } = await evidence();
  const workloads = value.workloads as Array<{ runs: Array<{ samples: Array<Record<string, unknown>> }> }>;
  workloads[0]!.runs[0]!.samples.pop();
  assert.equal(verifyM0Evidence(value, definition, digest).outcome, "rejected");
  const next = await evidence();
  const nextWorkloads = next.value.workloads as Array<{ runs: Array<{ samples: Array<Record<string, unknown>> }> }>;
  nextWorkloads[0]!.runs[0]!.samples[0]!.baselineNs = Number.NaN;
  assert.equal(verifyM0Evidence(next.value, next.definition, next.digest).outcome, "rejected");
});

test("rejects duplicate run identities and inconsistent environment identity", async () => {
  const duplicate = await evidence();
  const workloads = duplicate.value.workloads as Array<{ runs: Array<{ runId: string }> }>;
  workloads[0]!.runs[1]!.runId = workloads[0]!.runs[0]!.runId;
  assert.equal(verifyM0Evidence(duplicate.value, duplicate.definition, duplicate.digest).outcome, "rejected");

  const inconsistent = await evidence();
  (inconsistent.value.environment as Record<string, unknown>).commit = "b".repeat(40);
  assert.equal(verifyM0Evidence(inconsistent.value, inconsistent.definition, inconsistent.digest).outcome, "rejected");
});

test("defers evidence from a different requested environment", async () => {
  const { definition, digest, value } = await evidence();
  const result = verifyM0Evidence(value, definition, digest, "a".repeat(40), controlledEnvironment({ architecture: "arm64" }));
  assert.equal(result.outcome, "deferred");
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.includes("architecture")), true);
});

test("does not accept self-asserted evidence without independent revision and environment bindings", async () => {
  const { definition, digest, value } = await evidence();
  const unbound = verifyM0Evidence(value, definition, digest);
  assert.equal(unbound.outcome, "deferred");
  assert.ok(unbound.diagnostics.some((diagnostic) => diagnostic.includes("revision")));
  assert.ok(unbound.diagnostics.some((diagnostic) => diagnostic.includes("controlled environment")));
  const revisionOnly = verifyM0Evidence(value, definition, digest, "a".repeat(40));
  assert.equal(revisionOnly.outcome, "deferred");
  const environmentOnly = verifyM0Evidence(value, definition, digest, undefined, controlledEnvironment());
  assert.equal(environmentOnly.outcome, "deferred");
});

test("rejects an incomplete requested environment instead of treating it as controlled", async () => {
  const { definition, digest, value } = await evidence();
  const result = verifyM0Evidence(value, definition, digest, "a".repeat(40), { architecture: "x64" } as M0ExpectedEnvironment);
  assert.equal(result.outcome, "rejected");
  assert.match(result.diagnostics.join(" "), /requested environment/i);
});

test("defers a typed failed sample whose timing pair is incomplete", async () => {
  const { definition, digest, value } = await evidence();
  const workloads = value.workloads as Array<{ workloadId: string; runs: Array<{ samples: Array<Record<string, unknown>> }> }>;
  const sample = workloads.find((workload) => workload.workloadId === "small")!.runs[0]!.samples[0]!;
  sample.instrumentedNs = null;
  sample.overheadNs = null;
  sample.failure = { code: "INSTRUMENTED_FAILURE", message: "instrumented call failed" };
  const result = verifyM0Evidence(value, definition, digest);
  assert.equal(result.outcome, "deferred");
  assert.equal(result.workloads.find((workload) => workload.workloadId === "small")?.runs[0]?.p95Ms, null);
});
