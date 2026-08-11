import { fileURLToPath, pathToFileURL } from "node:url";
import { loadM0GateDefinition, type M0GateDefinition } from "./gate-definitions.js";

export interface M0WorkloadInput {
  readonly workloadId: string;
  readonly source: "node_observation" | "evidence_recorder";
  readonly samplesMs: readonly number[];
  readonly budgetMs: number;
  readonly failures: number;
}

export interface M0BudgetInput {
  readonly environment: { readonly nodeVersion: string; readonly os: string; readonly architecture: string };
  readonly workloads: readonly M0WorkloadInput[];
  readonly owner?: string;
  readonly dueGate?: string;
}

export interface M0BudgetReport {
  readonly schemaVersion: 1;
  readonly evidenceKind: "m0_interception_budget";
  readonly definitionVersion: M0GateDefinition["definitionVersion"];
  readonly definitionDigest: `sha256:${string}`;
  readonly decision: "accepted" | "deferred" | "rejected";
  readonly reason: string;
  readonly owner: string | null;
  readonly dueGate: string | null;
  readonly environment: M0BudgetInput["environment"];
  readonly workloads: readonly (M0WorkloadInput & { readonly p95Ms: number | null; readonly accepted: boolean })[];
}

const definitionRoot = fileURLToPath(new URL("../..", import.meta.url));
const [m0GateDefinition, m0GateDefinitionDigest] = await loadM0GateDefinition(definitionRoot);
const nodeObservationBoundaryTiers = new Map<string, number>(m0GateDefinition.workloads.map((workload) => [workload.workloadId, workload.budgetMs]));

/** Uses the nearest-rank percentile so the reported p95 is always one observed sample. */
export function p95FromSamples(samplesMs: readonly number[]): number | null {
  if (samplesMs.length === 0) return null;
  if (!samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)) return null;
  const ordered = [...samplesMs].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? null;
}

export function evaluateM0Budget(input: M0BudgetInput): M0BudgetReport {
  const requiredTiers = new Set<string>(nodeObservationBoundaryTiers.keys());
  const observedTiers = new Set(input.workloads.map((workload) => workload.workloadId));
  const hasRequiredTiers = input.workloads.length === requiredTiers.size
    && [...requiredTiers].every((tier) => observedTiers.has(tier));
  const recorderOnly = input.workloads.some((workload) => workload.source === "evidence_recorder");
  const workloads = input.workloads.map((workload) => {
    const p95Ms = p95FromSamples(workload.samplesMs);
    const fixedBudget = nodeObservationBoundaryTiers.get(workload.workloadId);
    const withinLegacyShape = fixedBudget !== undefined
      && workload.source === "node_observation"
      && Number.isInteger(workload.failures)
      && workload.failures === 0
      && workload.budgetMs === fixedBudget
      && workload.samplesMs.length === m0GateDefinition.measuredSamples
      && p95Ms !== null
      && p95Ms <= workload.budgetMs;
    return {
      ...workload,
      p95Ms,
      // This legacy one-run shape is diagnostic only and can never qualify M0.
      accepted: false,
      withinLegacyShape,
    };
  });
  const allWithinLegacyShape = hasRequiredTiers && workloads.every((workload) => workload.withinLegacyShape);
  const decision = "deferred" as const;
  const reason = recorderOnly
    ? "recorder-only evidence cannot accept the NodeObservationBoundary interception budget"
    : !hasRequiredTiers
      ? "NodeObservationBoundary evidence requires exactly the small, medium, and large workload tiers"
      : allWithinLegacyShape
        ? "legacy measurements are within budget but cannot accept M0; use the canonical paired three-run artifact verifier"
        : "one or more required observation workloads are failed or over their fixed budget";
  if (input.owner === undefined || input.dueGate === undefined) {
    throw new Error("deferred M0 decisions require owner and dueGate");
  }
  return {
    schemaVersion: 1,
    evidenceKind: "m0_interception_budget",
    definitionVersion: m0GateDefinition.definitionVersion,
    definitionDigest: m0GateDefinitionDigest,
    decision,
    reason,
    owner: input.owner ?? null,
    dueGate: input.dueGate ?? null,
    environment: input.environment,
    workloads: workloads.map(({ withinLegacyShape: _withinLegacyShape, ...workload }) => workload),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = evaluateM0Budget({
    environment: { nodeVersion: process.version, os: process.platform, architecture: process.arch },
    workloads: [],
    owner: "phase2-runtime",
    dueGate: "M0 observation benchmark",
  });
  console.log(JSON.stringify(report, null, 2));
}
