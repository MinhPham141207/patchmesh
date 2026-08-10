import { pathToFileURL } from "node:url";

export interface M0WorkloadInput {
  readonly workloadId: string;
  readonly source: "node_observation" | "evidence_recorder";
  readonly samplesMs: readonly number[];
  readonly p95Ms: number;
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
  readonly decision: "accepted" | "deferred" | "rejected";
  readonly reason: string;
  readonly owner: string | null;
  readonly dueGate: string | null;
  readonly environment: M0BudgetInput["environment"];
  readonly workloads: readonly (M0WorkloadInput & { readonly accepted: boolean })[];
}

export function evaluateM0Budget(input: M0BudgetInput): M0BudgetReport {
  const recorderOnly = input.workloads.some((workload) => workload.source === "evidence_recorder");
  const workloads = input.workloads.map((workload) => ({
    ...workload,
    accepted: workload.source === "node_observation"
      && workload.failures === 0
      && workload.samplesMs.length > 0
      && workload.p95Ms <= workload.budgetMs,
  }));
  const allAccepted = workloads.length > 0 && workloads.every((workload) => workload.accepted);
  const decision = allAccepted && !recorderOnly ? "accepted" : "deferred";
  const reason = recorderOnly
    ? "recorder-only evidence cannot accept the NodeObservationBoundary interception budget"
    : allAccepted
      ? "all declared observation workloads are within budget"
      : "one or more observation workloads are missing, failed, or over budget";
  if (decision === "deferred" && (input.owner === undefined || input.dueGate === undefined)) {
    throw new Error("deferred M0 decisions require owner and dueGate");
  }
  return {
    schemaVersion: 1,
    evidenceKind: "m0_interception_budget",
    decision,
    reason,
    owner: input.owner ?? null,
    dueGate: input.dueGate ?? null,
    environment: input.environment,
    workloads,
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
