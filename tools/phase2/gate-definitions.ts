import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type Sha256Digest = `sha256:${string}`;
export type FieldDetector = "same_symbol_overlap" | "stale_read_before_write" | "exported_contract_invalidation";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonRecord = { readonly [key: string]: unknown };

export interface M0WorkloadDefinition {
  readonly workloadId: "small" | "medium" | "large";
  readonly fileCount: 1000 | 10000 | 50000;
  readonly budgetMs: 250 | 1500 | 5000;
}

export interface M0GateDefinition {
  readonly schemaVersion: 1;
  readonly definitionVersion: "phase2-m0-v1";
  readonly metric: "incremental_interception_overhead_ms";
  readonly percentile: 0.95;
  readonly warmupSamples: 5;
  readonly measuredSamples: 30;
  readonly independentRuns: 3;
  readonly fixtureGenerator: {
    readonly version: "phase2-m0-fixture-v1";
    readonly contentSeed: "patchmesh-phase2-m0-v1";
    readonly fileSizeDistribution: { readonly kind: "fixed"; readonly bytesPerFile: 256 };
    readonly changedHotFilesPerOperation: 1;
  };
  readonly ignorePolicyVersion: "phase2-observation-ignore-v1";
  readonly requiresNetworkAccess: false;
  readonly requiresTemporaryLocalGitRepository: true;
  readonly requiresSqliteStore: true;
  readonly requiredEnvironmentFields: readonly string[];
  readonly workloads: readonly M0WorkloadDefinition[];
}

export interface M7GateDefinition {
  readonly schemaVersion: 1;
  readonly definitionVersion: "phase2-m7-v1";
  readonly detectors: readonly FieldDetector[];
  readonly holdoutRequirements: {
    readonly minimumPositiveCasesPerDetector: 30;
    readonly minimumNegativeCasesPerDetector: 150;
    readonly requiresIndependentReviewer: true;
    readonly requiresSufficientCoverage: true;
    readonly requiresDistinctProtocolEventSetDigests: true;
    readonly requiresScenarioDiversity: true;
  };
  readonly thresholds: {
    readonly minimumPrecision: 0.95;
    readonly minimumRecall: 0.9;
    readonly maximumBrierScore: 0.1;
    readonly maximumObservedFalsePositiveRate: 0.02;
    readonly maximumWilsonFalsePositiveRateUpperBound: 0.02;
    readonly wilsonConfidenceLevel: 0.95;
    readonly wilsonSidedness: "one_sided";
  };
}

const expectedM0Workloads = new Map<string, readonly [number, number]>([
  ["small", [1000, 250]],
  ["medium", [10000, 1500]],
  ["large", [50000, 5000]],
]);
const expectedM7Detectors = new Set<FieldDetector>([
  "same_symbol_overlap",
  "stale_read_before_write",
  "exported_contract_invalidation",
]);
const expectedEnvironmentFields = new Set([
  "timestamp", "commit", "dirty", "os", "osRelease", "architecture", "cpu", "memoryBytes", "nodeVersion", "pnpmVersion", "workloadDefinitionDigest",
]);

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const objectValue = value as { readonly [key: string]: Json };
    return `{${Object.keys(objectValue).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalSha256(value: Json): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function requireExactKeys(record: JsonRecord, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw new Error(`${label} contains missing or unknown properties`);
}

function requireExactValue<T>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must equal ${JSON.stringify(expected)}`);
  return expected;
}

function requireUniqueExactSet(values: unknown, expected: ReadonlySet<string>, label: string): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new Error(`${label} must be a string array`);
  const observed = new Set(values);
  if (observed.size !== values.length || observed.size !== expected.size || [...expected].some((value) => !observed.has(value))) {
    throw new Error(`${label} must contain each required value exactly once`);
  }
  return [...observed].sort((left, right) => left.localeCompare(right));
}

function parseM0GateDefinition(value: unknown): M0GateDefinition {
  const record = asRecord(value, "M0 definition");
  requireExactKeys(record, ["schemaVersion", "definitionVersion", "metric", "percentile", "warmupSamples", "measuredSamples", "independentRuns", "fixtureGenerator", "ignorePolicyVersion", "requiresNetworkAccess", "requiresTemporaryLocalGitRepository", "requiresSqliteStore", "requiredEnvironmentFields", "workloads"], "M0 definition");
  const fixture = asRecord(record.fixtureGenerator, "M0 fixtureGenerator");
  requireExactKeys(fixture, ["version", "contentSeed", "fileSizeDistribution", "changedHotFilesPerOperation"], "M0 fixtureGenerator");
  const distribution = asRecord(fixture.fileSizeDistribution, "M0 fileSizeDistribution");
  requireExactKeys(distribution, ["kind", "bytesPerFile"], "M0 fileSizeDistribution");
  const environmentFields = requireUniqueExactSet(record.requiredEnvironmentFields, expectedEnvironmentFields, "M0 requiredEnvironmentFields");
  if (!Array.isArray(record.workloads) || record.workloads.length !== expectedM0Workloads.size) throw new Error("M0 workloads must contain exactly three tiers");
  const seenWorkloads = new Set<string>();
  const workloads = record.workloads.map((value): M0WorkloadDefinition => {
    const workload = asRecord(value, "M0 workload");
    requireExactKeys(workload, ["workloadId", "fileCount", "budgetMs"], "M0 workload");
    if (typeof workload.workloadId !== "string" || seenWorkloads.has(workload.workloadId)) throw new Error("M0 workload IDs must be unique");
    seenWorkloads.add(workload.workloadId);
    const expected = expectedM0Workloads.get(workload.workloadId);
    if (expected === undefined || workload.fileCount !== expected[0] || workload.budgetMs !== expected[1]) throw new Error(`M0 workload ${workload.workloadId} is not a v1 tier`);
    return workload as unknown as M0WorkloadDefinition;
  }).sort((left, right) => left.workloadId.localeCompare(right.workloadId));
  return {
    schemaVersion: requireExactValue(record.schemaVersion, 1, "M0 schemaVersion"),
    definitionVersion: requireExactValue(record.definitionVersion, "phase2-m0-v1", "M0 definitionVersion"),
    metric: requireExactValue(record.metric, "incremental_interception_overhead_ms", "M0 metric"),
    percentile: requireExactValue(record.percentile, 0.95, "M0 percentile"),
    warmupSamples: requireExactValue(record.warmupSamples, 5, "M0 warmupSamples"),
    measuredSamples: requireExactValue(record.measuredSamples, 30, "M0 measuredSamples"),
    independentRuns: requireExactValue(record.independentRuns, 3, "M0 independentRuns"),
    fixtureGenerator: {
      version: requireExactValue(fixture.version, "phase2-m0-fixture-v1", "M0 fixture version"),
      contentSeed: requireExactValue(fixture.contentSeed, "patchmesh-phase2-m0-v1", "M0 fixture contentSeed"),
      fileSizeDistribution: {
        kind: requireExactValue(distribution.kind, "fixed", "M0 file-size distribution kind"),
        bytesPerFile: requireExactValue(distribution.bytesPerFile, 256, "M0 file-size distribution bytesPerFile"),
      },
      changedHotFilesPerOperation: requireExactValue(fixture.changedHotFilesPerOperation, 1, "M0 changedHotFilesPerOperation"),
    },
    ignorePolicyVersion: requireExactValue(record.ignorePolicyVersion, "phase2-observation-ignore-v1", "M0 ignorePolicyVersion"),
    requiresNetworkAccess: requireExactValue(record.requiresNetworkAccess, false, "M0 requiresNetworkAccess"),
    requiresTemporaryLocalGitRepository: requireExactValue(record.requiresTemporaryLocalGitRepository, true, "M0 requiresTemporaryLocalGitRepository"),
    requiresSqliteStore: requireExactValue(record.requiresSqliteStore, true, "M0 requiresSqliteStore"),
    requiredEnvironmentFields: environmentFields,
    workloads,
  };
}

function parseM7GateDefinition(value: unknown): M7GateDefinition {
  const record = asRecord(value, "M7 definition");
  requireExactKeys(record, ["schemaVersion", "definitionVersion", "detectors", "holdoutRequirements", "thresholds"], "M7 definition");
  const holdouts = asRecord(record.holdoutRequirements, "M7 holdoutRequirements");
  requireExactKeys(holdouts, ["minimumPositiveCasesPerDetector", "minimumNegativeCasesPerDetector", "requiresIndependentReviewer", "requiresSufficientCoverage", "requiresDistinctProtocolEventSetDigests", "requiresScenarioDiversity"], "M7 holdoutRequirements");
  const thresholds = asRecord(record.thresholds, "M7 thresholds");
  requireExactKeys(thresholds, ["minimumPrecision", "minimumRecall", "maximumBrierScore", "maximumObservedFalsePositiveRate", "maximumWilsonFalsePositiveRateUpperBound", "wilsonConfidenceLevel", "wilsonSidedness"], "M7 thresholds");
  return {
    schemaVersion: requireExactValue(record.schemaVersion, 1, "M7 schemaVersion"),
    definitionVersion: requireExactValue(record.definitionVersion, "phase2-m7-v1", "M7 definitionVersion"),
    detectors: requireUniqueExactSet(record.detectors, expectedM7Detectors, "M7 detectors") as readonly FieldDetector[],
    holdoutRequirements: {
      minimumPositiveCasesPerDetector: requireExactValue(holdouts.minimumPositiveCasesPerDetector, 30, "M7 minimum positive cases"),
      minimumNegativeCasesPerDetector: requireExactValue(holdouts.minimumNegativeCasesPerDetector, 150, "M7 minimum negative cases"),
      requiresIndependentReviewer: requireExactValue(holdouts.requiresIndependentReviewer, true, "M7 requiresIndependentReviewer"),
      requiresSufficientCoverage: requireExactValue(holdouts.requiresSufficientCoverage, true, "M7 requiresSufficientCoverage"),
      requiresDistinctProtocolEventSetDigests: requireExactValue(holdouts.requiresDistinctProtocolEventSetDigests, true, "M7 requiresDistinctProtocolEventSetDigests"),
      requiresScenarioDiversity: requireExactValue(holdouts.requiresScenarioDiversity, true, "M7 requiresScenarioDiversity"),
    },
    thresholds: {
      minimumPrecision: requireExactValue(thresholds.minimumPrecision, 0.95, "M7 minimumPrecision"),
      minimumRecall: requireExactValue(thresholds.minimumRecall, 0.9, "M7 minimumRecall"),
      maximumBrierScore: requireExactValue(thresholds.maximumBrierScore, 0.1, "M7 maximumBrierScore"),
      maximumObservedFalsePositiveRate: requireExactValue(thresholds.maximumObservedFalsePositiveRate, 0.02, "M7 maximumObservedFalsePositiveRate"),
      maximumWilsonFalsePositiveRateUpperBound: requireExactValue(thresholds.maximumWilsonFalsePositiveRateUpperBound, 0.02, "M7 maximumWilsonFalsePositiveRateUpperBound"),
      wilsonConfidenceLevel: requireExactValue(thresholds.wilsonConfidenceLevel, 0.95, "M7 wilsonConfidenceLevel"),
      wilsonSidedness: requireExactValue(thresholds.wilsonSidedness, "one_sided", "M7 wilsonSidedness"),
    },
  };
}

export async function loadM0GateDefinition(root = process.cwd()): Promise<readonly [M0GateDefinition, Sha256Digest]> {
  const definition = parseM0GateDefinition(JSON.parse(await readFile(resolve(root, "benchmarks/phase2/m0-workloads.v1.json"), "utf8")));
  return [definition, canonicalSha256(definition as unknown as Json)];
}

export async function loadM7GateDefinition(root = process.cwd()): Promise<readonly [M7GateDefinition, Sha256Digest]> {
  const definition = parseM7GateDefinition(JSON.parse(await readFile(resolve(root, "benchmarks/phase2/m7-quality-gate.v1.json"), "utf8")));
  return [definition, canonicalSha256(definition as unknown as Json)];
}
