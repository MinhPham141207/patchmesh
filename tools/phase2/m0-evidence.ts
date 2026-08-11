import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { M0GateDefinition, Sha256Digest } from "./gate-definitions.js";
import { validateJsonSchemaInstance } from "./json-schema.js";

export type M0EvidenceOutcome = "accepted" | "deferred" | "rejected";

export interface M0Verification {
  readonly outcome: M0EvidenceOutcome;
  readonly diagnostics: readonly string[];
  readonly workloads: readonly {
    readonly workloadId: string;
    readonly p50Ms: number | null;
    readonly gateP95Ms: number | null;
    readonly failures: number;
    readonly accepted: boolean;
    readonly runs: readonly {
      readonly runId: string;
      readonly p50Ms: number | null;
      readonly p95Ms: number | null;
      readonly failures: number;
    }[];
  }[];
}

export interface M0ExpectedEnvironment {
  readonly os: string;
  readonly osRelease: string;
  readonly architecture: string;
  readonly cpu: string;
  readonly memoryBytes: number;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
}

const expectedEnvironmentKeys = ["os", "osRelease", "architecture", "cpu", "memoryBytes", "nodeVersion", "pnpmVersion"] as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is RecordValue {
  return isRecord(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nearestRank(samples: readonly number[], percentile: number): number | null {
  if (samples.length === 0) return null;
  return [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * percentile) - 1] ?? null;
}

function reject(diagnostics: readonly string[]): M0Verification {
  return { outcome: "rejected", diagnostics: [...diagnostics].sort((left, right) => left.localeCompare(right)), workloads: [] };
}

export async function validateM0EvidenceSchema(value: unknown, root = process.cwd()): Promise<readonly string[]> {
  let schema: unknown;
  try {
    schema = JSON.parse(await readFile(resolve(root, "benchmarks/phase2/m0-evidence.v1.schema.json"), "utf8"));
  } catch {
    return ["M0 evidence schema could not be read as JSON"];
  }
  return validateJsonSchemaInstance(schema, value).map((diagnostic) => `M0 evidence schema ${diagnostic}`);
}

export async function verifyM0EvidenceWithSchema(
  value: unknown,
  definition: M0GateDefinition,
  definitionDigest: Sha256Digest,
  expectedCommit?: string,
  expectedEnvironment?: M0ExpectedEnvironment,
  root = process.cwd(),
): Promise<M0Verification> {
  const diagnostics = await validateM0EvidenceSchema(value, root);
  return diagnostics.length > 0 ? reject(diagnostics) : verifyM0Evidence(value, definition, definitionDigest, expectedCommit, expectedEnvironment);
}

/**
 * Recomputes M0 gate values exclusively from retained raw samples. Supplied summaries,
 * decisions, and reasons are deliberately not part of the accepted artifact shape.
 */
export function verifyM0Evidence(
  value: unknown,
  definition: M0GateDefinition,
  definitionDigest: Sha256Digest,
  expectedCommit?: string,
  expectedEnvironment?: M0ExpectedEnvironment,
): M0Verification {
  const rootKeys = ["schemaVersion", "evidenceKind", "definitionVersion", "definitionDigest", "generatedAt", "commit", "gitDirty", "environment", "workloads", "decision", "reason", "owner", "dueGate"];
  if (!hasExactKeys(value, rootKeys)) return reject(["M0 evidence has missing or unknown properties"]);
  const evidence = value;
  if (evidence.schemaVersion !== 1 || evidence.evidenceKind !== "m0_interception_budget") return reject(["M0 evidence has an unsupported schema or kind"]);
  if (evidence.definitionVersion !== definition.definitionVersion || evidence.definitionDigest !== definitionDigest) return reject(["M0 evidence definition does not match the loaded contract"]);
  if (expectedCommit !== undefined && !/^[0-9a-f]{40,64}$/u.test(expectedCommit)) return reject(["M0 requested revision is invalid"]);
  if (expectedEnvironment !== undefined && (!hasExactKeys(expectedEnvironment, expectedEnvironmentKeys)
    || !isNonEmptyString(expectedEnvironment.os) || !isNonEmptyString(expectedEnvironment.osRelease)
    || !isNonEmptyString(expectedEnvironment.architecture) || !isNonEmptyString(expectedEnvironment.cpu)
    || !isFiniteNonNegative(expectedEnvironment.memoryBytes) || expectedEnvironment.memoryBytes === 0
    || !isNonEmptyString(expectedEnvironment.nodeVersion) || !isNonEmptyString(expectedEnvironment.pnpmVersion))) {
    return reject(["M0 requested environment is invalid"]);
  }
  if (typeof evidence.generatedAt !== "string" || !Number.isFinite(Date.parse(evidence.generatedAt))) return reject(["M0 evidence generatedAt is invalid"]);
  if (typeof evidence.commit !== "string" || !/^[0-9a-f]{40,64}$/u.test(evidence.commit)) return reject(["M0 evidence commit is invalid"]);
  if (typeof evidence.gitDirty !== "boolean") return reject(["M0 evidence gitDirty is invalid"]);
  if (!["accepted", "deferred", "rejected"].includes(evidence.decision as string) || typeof evidence.reason !== "string" || (evidence.owner !== null && typeof evidence.owner !== "string") || (evidence.dueGate !== null && typeof evidence.dueGate !== "string")) {
    return reject(["M0 evidence decision metadata is invalid"]);
  }
  if (!hasExactKeys(evidence.environment, definition.requiredEnvironmentFields)) return reject(["M0 evidence environment has missing or unknown properties"]);
  const environment = evidence.environment;
  if (typeof environment.timestamp !== "string" || !Number.isFinite(Date.parse(environment.timestamp))
    || !isNonEmptyString(environment.commit) || environment.commit !== evidence.commit
    || typeof environment.dirty !== "boolean" || environment.dirty !== evidence.gitDirty
    || !isNonEmptyString(environment.os) || !isNonEmptyString(environment.osRelease)
    || !isNonEmptyString(environment.architecture) || !isNonEmptyString(environment.cpu)
    || typeof environment.memoryBytes !== "number" || !Number.isFinite(environment.memoryBytes) || environment.memoryBytes <= 0
    || !isNonEmptyString(environment.nodeVersion) || !isNonEmptyString(environment.pnpmVersion)
    || environment.workloadDefinitionDigest !== definitionDigest) {
    return reject(["M0 evidence environment identity is invalid or inconsistent"]);
  }
  if (!Array.isArray(evidence.workloads) || evidence.workloads.length !== definition.workloads.length) return reject(["M0 evidence must contain every required workload exactly once"]);

  const seenWorkloads = new Set<string>();
  const recomputed: Array<M0Verification["workloads"][number]> = [];
  const structuralDiagnostics: string[] = [];
  for (const valueWorkload of evidence.workloads) {
    const workloadKeys = ["workloadId", "fileCount", "budgetMs", "coldInitializationMs", "coldInitializationRunsMs", "runs", "gateP95Ms", "failures", "accepted"];
    if (!hasExactKeys(valueWorkload, workloadKeys) || typeof valueWorkload.workloadId !== "string") {
      structuralDiagnostics.push("M0 evidence contains an invalid workload");
      continue;
    }
    if (seenWorkloads.has(valueWorkload.workloadId)) {
      structuralDiagnostics.push(`M0 evidence duplicates workload ${valueWorkload.workloadId}`);
      continue;
    }
    seenWorkloads.add(valueWorkload.workloadId);
    const contractWorkload = definition.workloads.find((item) => item.workloadId === valueWorkload.workloadId);
    const suppliedWorkloadSummaryValid = (valueWorkload.gateP95Ms === null || isFiniteNonNegative(valueWorkload.gateP95Ms))
      && Number.isInteger(valueWorkload.failures) && isFiniteNonNegative(valueWorkload.failures)
      && typeof valueWorkload.accepted === "boolean";
    const coldRunValues = Array.isArray(valueWorkload.coldInitializationRunsMs)
      ? valueWorkload.coldInitializationRunsMs
      : null;
    const validColdRuns = coldRunValues !== null
      && coldRunValues.length === definition.independentRuns
      && coldRunValues.every(isFiniteNonNegative);
    const coldAverage = validColdRuns
      ? (coldRunValues as number[]).reduce((sum, item) => sum + item, 0) / definition.independentRuns
      : null;
    if (contractWorkload === undefined || valueWorkload.fileCount !== contractWorkload.fileCount || valueWorkload.budgetMs !== contractWorkload.budgetMs || !isFiniteNonNegative(valueWorkload.coldInitializationMs) || coldAverage === null || valueWorkload.coldInitializationMs !== coldAverage || !suppliedWorkloadSummaryValid || !Array.isArray(valueWorkload.runs) || valueWorkload.runs.length !== definition.independentRuns) {
      structuralDiagnostics.push(`M0 evidence workload ${valueWorkload.workloadId} does not match the contract`);
      continue;
    }
    const runP95s: number[] = [];
    const runP50s: number[] = [];
    const runVerifications: Array<M0Verification["workloads"][number]["runs"][number]> = [];
    const seenRunIds = new Set<string>();
    let failures = 0;
    for (const run of valueWorkload.runs) {
      if (!hasExactKeys(run, ["runId", "warmupSamples", "samples", "p50Ms", "p95Ms"]) || !isNonEmptyString(run.runId) || seenRunIds.has(run.runId) || (run.p50Ms !== null && !isFiniteNonNegative(run.p50Ms)) || (run.p95Ms !== null && !isFiniteNonNegative(run.p95Ms)) || !Array.isArray(run.warmupSamples) || run.warmupSamples.length !== definition.warmupSamples || !Array.isArray(run.samples) || run.samples.length !== definition.measuredSamples) {
        structuralDiagnostics.push(`M0 evidence workload ${valueWorkload.workloadId} has invalid run structure`);
        continue;
      }
      seenRunIds.add(run.runId);
      const overheads: number[] = [];
      let runFailures = 0;
      const rawSamples = [
        ...run.warmupSamples.map((sample) => ({ sample, measured: false })),
        ...run.samples.map((sample) => ({ sample, measured: true })),
      ];
      for (const { sample, measured } of rawSamples) {
        if (!hasExactKeys(sample, ["baselineNs", "instrumentedNs", "overheadNs", "failure"])) {
          structuralDiagnostics.push(`M0 evidence workload ${valueWorkload.workloadId} has an invalid sample`);
          continue;
        }
        const failureValid = sample.failure === null
          || (hasExactKeys(sample.failure, ["code", "message"]) && isNonEmptyString(sample.failure.code) && isNonEmptyString(sample.failure.message));
        const baselineValid = sample.baselineNs === null || isFiniteNonNegative(sample.baselineNs);
        const instrumentedValid = sample.instrumentedNs === null || isFiniteNonNegative(sample.instrumentedNs);
        const overheadValid = sample.overheadNs === null || isFiniteNonNegative(sample.overheadNs);
        const completeTiming = typeof sample.baselineNs === "number" && typeof sample.instrumentedNs === "number" && typeof sample.overheadNs === "number";
        if (!failureValid || !baselineValid || !instrumentedValid || !overheadValid || (sample.failure === null && !completeTiming)) {
          structuralDiagnostics.push(`M0 evidence workload ${valueWorkload.workloadId} has an invalid sample`);
          continue;
        }
        if (typeof sample.baselineNs === "number" && typeof sample.instrumentedNs === "number" && typeof sample.overheadNs === "number"
          && sample.overheadNs !== Math.max(0, sample.instrumentedNs - sample.baselineNs)) structuralDiagnostics.push(`M0 evidence workload ${valueWorkload.workloadId} has an inconsistent overhead sample`);
        if (sample.failure !== null) { failures += 1; runFailures += 1; }
        if (measured && typeof sample.overheadNs === "number") overheads.push(sample.overheadNs / 1_000_000);
      }
      const retainedComplete = overheads.length === definition.measuredSamples;
      const p95 = retainedComplete ? nearestRank(overheads, definition.percentile) : null;
      const p50 = retainedComplete ? nearestRank(overheads, 0.5) : null;
      if (p95 !== null && p50 !== null) {
        runP95s.push(p95);
        runP50s.push(p50);
      }
      runVerifications.push({ runId: run.runId, p50Ms: p50, p95Ms: p95, failures: runFailures });
    }
    const p50Ms = runP50s.length === definition.independentRuns ? Math.max(...runP50s) : null;
    const gateP95Ms = runP95s.length === definition.independentRuns ? Math.max(...runP95s) : null;
    recomputed.push({
      workloadId: valueWorkload.workloadId,
      p50Ms,
      gateP95Ms,
      failures,
      accepted: failures === 0 && gateP95Ms !== null && gateP95Ms <= contractWorkload.budgetMs,
      runs: runVerifications,
    });
  }
  if (structuralDiagnostics.length > 0 || seenWorkloads.size !== definition.workloads.length) return reject(structuralDiagnostics.length > 0 ? structuralDiagnostics : ["M0 evidence is missing a required workload"]);

  const deferredDiagnostics: string[] = [];
  if (evidence.gitDirty) deferredDiagnostics.push("M0 evidence was generated from a dirty worktree");
  if (expectedCommit === undefined) deferredDiagnostics.push("M0 verification did not bind an independently requested revision");
  else if (evidence.commit !== expectedCommit) deferredDiagnostics.push("M0 evidence commit does not match the requested revision");
  if (expectedEnvironment === undefined) {
    deferredDiagnostics.push("M0 verification did not bind an independently requested controlled environment");
  } else {
    for (const [key, expected] of Object.entries(expectedEnvironment)) {
      if (environment[key] !== expected) deferredDiagnostics.push(`M0 evidence environment ${key} does not match the requested environment`);
    }
  }
  for (const key of ["os", "osRelease", "architecture", "cpu", "nodeVersion", "pnpmVersion"] as const) {
    if (["unknown", "unavailable"].includes(String(environment[key]).toLowerCase())) deferredDiagnostics.push(`M0 evidence environment ${key} is not identified`);
  }
  for (const workload of recomputed) {
    const contractWorkload = definition.workloads.find((item) => item.workloadId === workload.workloadId)!;
    if (workload.failures > 0) deferredDiagnostics.push(`${workload.workloadId} has failed samples`);
    if (workload.gateP95Ms === null || workload.gateP95Ms > contractWorkload.budgetMs) deferredDiagnostics.push(`${workload.workloadId} exceeds its M0 budget`);
  }
  return {
    outcome: deferredDiagnostics.length === 0 ? "accepted" : "deferred",
    diagnostics: deferredDiagnostics.sort((left, right) => left.localeCompare(right)),
    workloads: recomputed.sort((left, right) => left.workloadId.localeCompare(right.workloadId)),
  };
}
