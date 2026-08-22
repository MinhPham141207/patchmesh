import { createHash } from "node:crypto";
import type { DecisionId, FindingId } from "patchmesh-protocol";
import type { DetectorFinding, ReportOnlyDecision } from "./types.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Stable replay identities based solely on detector evidence and policy output. */
export function findingIdFor(finding: DetectorFinding): FindingId {
  return `finding_${digest({ type: finding.findingType, evidence: finding.evidence }).slice(0, 32)}` as FindingId;
}

export function decisionIdFor(findingId: FindingId, decision: ReportOnlyDecision, taskId: string | null): DecisionId {
  return `decision_${digest({ findingId, action: decision.action, directive: decision.gatewayDirective, taskId }).slice(0, 32)}` as DecisionId;
}
