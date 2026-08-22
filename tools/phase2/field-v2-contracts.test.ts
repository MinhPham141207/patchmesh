import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { digestHostAdapterCapabilities, type HostAdapterCapabilities } from "patchmesh-adapters";
import type { ProtocolEvent } from "patchmesh-protocol";
import { canonicalSha256 } from "./gate-definitions.js";
import {
  loadFieldCaseBundleV2,
  loadGeneratedFieldOutputV2,
  parseFieldCaseIndexV2,
  parseFieldInputV2,
  parseFieldLabelV2,
  parseGeneratedFieldOutputV2,
  validateFieldCaseIndexV2,
  validateFieldInputV2,
  validateFieldLabelV2,
  validateGeneratedFieldOutputV2,
  type FieldCaseIndexV2,
  type FieldInputV2,
  type FieldLabelV2,
  type GeneratedFieldOutputV2,
} from "./field-v2-contracts.js";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
const digest = (value: unknown) => canonicalSha256(value as Json);
const caseId = "same-symbol-positive-001";
const detector = "same_symbol_overlap" as const;
const repositoryRoot = resolve(import.meta.dirname, "../..");
const schemaNames = ["field-case-index.v2", "field-input.v2", "field-label.v2", "generated-field-output.v2"] as const;

const adapter: HostAdapterCapabilities = {
  schemaVersion: 1,
  runtime: "controlled-runtime",
  runtimeVersion: "1.0.0",
  adapterVersion: "1.0.0",
  wrapsToolExecution: true,
  authoritativeIdentity: true,
  taskLifecycle: true,
  exactReportedEffects: true,
  integrationTargetSnapshot: true,
  concurrentWorktreeObservation: true,
  observedReadVersion: true,
  dependentWriteToken: true,
};

const event: ProtocolEvent = {
  schemaVersion: 1,
  eventId: "evt_00000000000000000000000000000001",
  eventType: "tool.requested",
  source: { kind: "adapter", sourceId: "source_field_fixture", instanceId: "11111111-1111-4111-8111-111111111111" },
  timestamp: "2026-08-12T00:00:00.000Z",
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_22222222-2222-4222-8222-222222222222",
  worktreeId: "wt_33333333-3333-4333-8333-333333333333",
  agentId: null,
  taskId: null,
  correlationId: "corr_00000000000000000000000000000001",
  causationId: null,
  sourceSequence: 1,
  payload: { toolName: "edit_file", operation: "fixture", targetResourceId: null, opaque: false },
};

function inputFixture(overrides: Partial<FieldInputV2> = {}): FieldInputV2 {
  const protocolEvents = [event];
  return {
    schemaVersion: 2,
    caseId,
    source: "real_production_adapter",
    repositoryDomain: "domain-fixture-001",
    adapter,
    adapterCapabilityDigest: digestHostAdapterCapabilities(adapter),
    integrationTargetSnapshotId: "snapshot-fixture-001",
    detector,
    target: { resourceId: `res_${"1".repeat(64)}`, affectedTaskId: null },
    protocolEvents,
    protocolEventSetDigest: digest(protocolEvents),
    limitations: [],
    ...overrides,
  };
}

function labelFixture(overrides: Partial<FieldLabelV2> = {}): FieldLabelV2 {
  return {
    schemaVersion: 2,
    caseId,
    expectedFinding: true,
    reviewerId: "reviewer-001",
    reviewedAt: "2026-08-12T00:00:00.000Z",
    rationale: "Independently reviewed fixture.",
    labelPolicyVersion: "phase2-field-label-v1",
    collectorId: "collector-001",
    ...overrides,
  };
}

function outputFixture(inputDigest: `sha256:${string}`, overrides: Partial<GeneratedFieldOutputV2> = {}): GeneratedFieldOutputV2 {
  return {
    schemaVersion: 2,
    caseId,
    detector,
    detectorVersion: "1.0.0",
    codeCommit: "1".repeat(40),
    inputDigest,
    observedFinding: true,
    predictedProbability: 0.95,
    matchingFindingIds: [`finding_${"1".repeat(32)}`],
    allFindingDigest: digest([]),
    diagnostics: [],
    ...overrides,
  };
}

function indexFixture(input: FieldInputV2, label: FieldLabelV2, overrides: Partial<FieldCaseIndexV2["cases"][number]> = {}): FieldCaseIndexV2 {
  return {
    schemaVersion: 2,
    corpusVersion: "field-v2",
    cases: [{
      caseId,
      detector,
      inputPath: `.evidence/corpus/field-v2/inputs/${caseId}.json`,
      inputDigest: digest(input),
      labelPath: `.evidence/corpus/field-v2/labels/${caseId}.json`,
      labelDigest: digest(label),
      scenarioFamily: "same-symbol-real-adapter",
      holdout: true,
      ...overrides,
    }],
  };
}

function installSchemas(root: string): void {
  const schemaDirectory = join(root, ".evidence", "schema");
  mkdirSync(schemaDirectory, { recursive: true });
  for (const name of schemaNames) {
    copyFileSync(
      join(repositoryRoot, ".evidence", "schema", `${name}.schema.json`),
      join(schemaDirectory, `${name}.schema.json`),
    );
  }
}

function writeBundle(root: string, input = inputFixture(), label = labelFixture(), index = indexFixture(input, label)): void {
  installSchemas(root);
  mkdirSync(join(root, ".evidence", "corpus", "field-v2", "inputs"), { recursive: true });
  mkdirSync(join(root, ".evidence", "corpus", "field-v2", "labels"), { recursive: true });
  writeFileSync(join(root, ".evidence", "corpus", "field-v2", "inputs", `${caseId}.json`), JSON.stringify(input));
  writeFileSync(join(root, ".evidence", "corpus", "field-v2", "labels", `${caseId}.json`), JSON.stringify(label));
  writeFileSync(join(root, ".evidence", "corpus", "field-v2", "corpus.json"), JSON.stringify(index));
}

test("field-v2 schemas are checked in with strict owned object shapes", () => {
  for (const name of schemaNames) {
    const schema = JSON.parse(readFileSync(join(repositoryRoot, ".evidence", "schema", `${name}.schema.json`), "utf8")) as { additionalProperties?: unknown };
    assert.equal(schema.additionalProperties, false, name);
  }
});

test("field-v2 loaders execute JSON-schema validation separately from semantic validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-field-v2-schema-"));
  try {
    writeBundle(root);
    const schemaPath = join(root, ".evidence", "schema", "field-label.v2.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties: Record<string, unknown>;
    };
    schema.properties.labelPolicyVersion = { const: "required-test-policy" };
    writeFileSync(schemaPath, JSON.stringify(schema));
    await assert.rejects(
      loadFieldCaseBundleV2(".evidence/corpus/field-v2/corpus.json", root),
      /JSON-schema validation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("field-v2 parsers reject unknown fields at every owned nesting boundary", () => {
  const input = inputFixture();
  const label = labelFixture();
  const index = indexFixture(input, label);
  assert.throws(() => parseFieldCaseIndexV2({ ...index, unexpected: true }), /unknown properties/);
  assert.throws(() => parseFieldCaseIndexV2({ ...index, cases: [{ ...index.cases[0], unexpected: true }] }), /unknown properties/);
  assert.throws(() => parseFieldInputV2({ ...input, target: { ...input.target, unexpected: true } }), /unknown properties/);
  assert.throws(() => parseFieldInputV2({ ...input, adapter: { ...adapter, unexpected: true } }), /unknown properties/);
  assert.throws(() => parseFieldLabelV2({ ...label, observedFinding: true }), /unknown properties/);
  assert.throws(() => parseGeneratedFieldOutputV2({ ...outputFixture(digest(input)), expectedFinding: true }), /unknown properties/);
  assert.throws(() => parseGeneratedFieldOutputV2({ ...outputFixture(digest(input)), reviewerId: "reviewer-001" }), /unknown properties/);
});

test("field-v2 semantic validators enforce digest binding and reviewer/output separation", () => {
  const input = inputFixture({ adapterCapabilityDigest: `sha256:${"0".repeat(64)}` });
  assert.match(validateFieldInputV2(input).join("; "), /capability digest/);
  assert.match(validateFieldInputV2(inputFixture({ protocolEventSetDigest: `sha256:${"0".repeat(64)}` })).join("; "), /event-set digest/);
  assert.match(validateFieldLabelV2(labelFixture({ collectorId: "reviewer-001" })).join("; "), /must differ/);
  assert.match(validateFieldLabelV2(labelFixture({ reviewedAt: "August 12, 2026" })).join("; "), /RFC 3339/);
  assert.match(validateGeneratedFieldOutputV2(outputFixture(digest(input), { predictedProbability: 1.1 })).join("; "), /between zero and one/);
  assert.match(validateFieldCaseIndexV2(indexFixture(inputFixture(), labelFixture(), { inputPath: `../${caseId}.json` })).join("; "), /confined/);
});

test("field-v2 bundle loader validates canonical paths, digests, and generated binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-field-v2-"));
  try {
    const input = inputFixture();
    const label = labelFixture();
    writeBundle(root, input, label);
    const loaded = await loadFieldCaseBundleV2(".evidence/corpus/field-v2/corpus.json", root);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.input.detector, detector);

    mkdirSync(join(root, ".evidence", "field-output"), { recursive: true });
    const output = outputFixture(digest(input));
    writeFileSync(join(root, ".evidence", "field-output", `${caseId}.json`), JSON.stringify(output));
    assert.deepEqual(await loadGeneratedFieldOutputV2(`.evidence/field-output/${caseId}.json`, { caseId, detector, inputDigest: digest(input) }, root), output);
    await assert.rejects(loadGeneratedFieldOutputV2(`.evidence/field-output/${caseId}.json`, { caseId, detector: "stale_read_before_write", inputDigest: digest(input) }, root), /does not match/);

    writeBundle(root, input, label, indexFixture(input, label, { inputDigest: `sha256:${"0".repeat(64)}` }));
    await assert.rejects(loadFieldCaseBundleV2(".evidence/corpus/field-v2/corpus.json", root), /input digest/);
    await assert.rejects(loadFieldCaseBundleV2("../corpus.json", root), /index path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("field-v2 bundle loader rejects a symlinked artifact root", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-field-v2-root-"));
  const outside = mkdtempSync(join(tmpdir(), "patchmesh-field-v2-outside-"));
  try {
    const input = inputFixture();
    const label = labelFixture();
    installSchemas(root);
    mkdirSync(join(root, ".evidence", "corpus", "field-v2", "labels"), { recursive: true });
    mkdirSync(join(outside, "inputs"), { recursive: true });
    writeFileSync(join(outside, "inputs", `${caseId}.json`), JSON.stringify(input));
    try {
      symlinkSync(join(outside, "inputs"), join(root, ".evidence", "corpus", "field-v2", "inputs"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip("symlinks require an unavailable Windows privilege"); return; }
      throw error;
    }
    writeFileSync(join(root, ".evidence", "corpus", "field-v2", "labels", `${caseId}.json`), JSON.stringify(label));
    writeFileSync(join(root, ".evidence", "corpus", "field-v2", "corpus.json"), JSON.stringify(indexFixture(input, label)));
    await assert.rejects(loadFieldCaseBundleV2(".evidence/corpus/field-v2/corpus.json", root), /symbolic-link/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
