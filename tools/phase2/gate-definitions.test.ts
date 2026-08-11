import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadM0GateDefinition, loadM7GateDefinition } from "./gate-definitions.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function withDefinitions(
  mutate: (m0: Record<string, unknown>, m7: Record<string, unknown>) => void | Promise<void>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "patchmesh-phase2-gates-"));
  try {
    const definitionDirectory = join(root, "benchmarks", "phase2");
    await mkdir(definitionDirectory, { recursive: true });
    const m0 = JSON.parse(await readFile(join(repositoryRoot, "benchmarks", "phase2", "m0-workloads.v1.json"), "utf8")) as Record<string, unknown>;
    const m7 = JSON.parse(await readFile(join(repositoryRoot, "benchmarks", "phase2", "m7-quality-gate.v1.json"), "utf8")) as Record<string, unknown>;
    await mutate(m0, m7);
    await writeFile(join(definitionDirectory, "m0-workloads.v1.json"), JSON.stringify(m0), "utf8");
    await writeFile(join(definitionDirectory, "m7-quality-gate.v1.json"), JSON.stringify(m7), "utf8");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("loads the checked-in versioned definitions and produces stable digests", async () => {
  const [m0, m0Digest] = await loadM0GateDefinition(repositoryRoot);
  const [m7, m7Digest] = await loadM7GateDefinition(repositoryRoot);

  assert.equal(m0.workloads.length, 3);
  assert.equal(m7.detectors.length, 3);
  assert.match(m0Digest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(m7Digest, /^sha256:[a-f0-9]{64}$/u);
});

test("checked-in M0 evidence schema is strict and bound to the canonical run counts", async () => {
  const [definition] = await loadM0GateDefinition(repositoryRoot);
  const schema = JSON.parse(await readFile(join(repositoryRoot, "benchmarks", "phase2", "m0-evidence.v1.schema.json"), "utf8")) as Record<string, unknown>;
  const definitions = schema.$defs as Record<string, Record<string, unknown>>;
  const workloadProperties = definitions.workload!.properties as Record<string, Record<string, unknown>>;
  const runProperties = definitions.run!.properties as Record<string, Record<string, unknown>>;
  const environment = definitions.environment!;
  assert.equal(schema.additionalProperties, false);
  assert.equal(definitions.environment!.additionalProperties, false);
  assert.equal(definitions.workload!.additionalProperties, false);
  assert.equal(definitions.run!.additionalProperties, false);
  assert.equal(definitions.sample!.additionalProperties, false);
  assert.equal(workloadProperties.runs!.minItems, definition.independentRuns);
  assert.equal(workloadProperties.runs!.maxItems, definition.independentRuns);
  assert.equal(runProperties.warmupSamples!.minItems, definition.warmupSamples);
  assert.equal(runProperties.warmupSamples!.maxItems, definition.warmupSamples);
  assert.equal(runProperties.samples!.minItems, definition.measuredSamples);
  assert.equal(runProperties.samples!.maxItems, definition.measuredSamples);
  assert.deepEqual(new Set(environment.required as string[]), new Set(definition.requiredEnvironmentFields));
});

test("rejects unknown or modified M0 definition fields", async () => {
  await withDefinitions((m0) => {
    m0.untrustedDecision = "accepted";
  }, async (root) => {
    await assert.rejects(loadM0GateDefinition(root), /missing or unknown properties/);
  });

  await withDefinitions((m0) => {
    const workloads = m0.workloads as Array<Record<string, unknown>>;
    workloads[0]!.budgetMs = 251;
  }, async (root) => {
    await assert.rejects(loadM0GateDefinition(root), /not a v1 tier/);
  });
});

test("rejects duplicate M0 tiers even when their contents are otherwise valid", async () => {
  await withDefinitions((m0) => {
    const workloads = m0.workloads as Array<Record<string, unknown>>;
    workloads[1] = { ...workloads[0]! };
  }, async (root) => {
    await assert.rejects(loadM0GateDefinition(root), /workload IDs must be unique/);
  });
});

test("rejects unknown M7 nested fields and duplicate detectors", async () => {
  await withDefinitions((_m0, m7) => {
    (m7.thresholds as Record<string, unknown>).alternateThreshold = 0;
  }, async (root) => {
    await assert.rejects(loadM7GateDefinition(root), /missing or unknown properties/);
  });

  await withDefinitions((_m0, m7) => {
    m7.detectors = ["same_symbol_overlap", "same_symbol_overlap", "exported_contract_invalidation"];
  }, async (root) => {
    await assert.rejects(loadM7GateDefinition(root), /each required value exactly once/);
  });
});
