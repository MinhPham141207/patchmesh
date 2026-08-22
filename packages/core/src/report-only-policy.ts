import type { FindingType, TaskId } from "patchmesh-protocol";

import type { DetectorFinding, ReportOnlyDecision } from "./types.js";

export interface ReportOnlyPolicyInput {
  readonly finding: DetectorFinding;
  readonly affectedTaskCompleted: boolean;
}

export interface ReportOnlyPolicyResult extends ReportOnlyDecision {
  readonly findingType: FindingType;
  readonly targetTaskId: TaskId | null;
}

/**
 * Maps deterministic detector output to Phase 2's deliberately
 * non-disruptive coordination vocabulary. It creates no events or effects.
 */
export function evaluateReportOnlyPolicy(
  input: ReportOnlyPolicyInput,
): ReportOnlyPolicyResult {
  const { finding } = input;
  if (finding.confidence < 0.5) {
    return {
      findingType: finding.findingType,
      targetTaskId: finding.evidence.affectedTaskId,
      action: "record",
      gatewayDirective: "allow",
    };
  }

  if (input.affectedTaskCompleted
    && (finding.findingType === "stale_read_before_write"
      || finding.findingType === "exported_contract_invalidation")) {
    return {
      findingType: finding.findingType,
      targetTaskId: finding.evidence.affectedTaskId,
      action: "request_revalidation",
      gatewayDirective: "allow_with_notice",
    };
  }

  return {
    findingType: finding.findingType,
    targetTaskId: finding.evidence.affectedTaskId,
    action: finding.findingType === "stale_read_before_write"
      ? "request_recheck"
      : "notify",
    gatewayDirective: "allow_with_notice",
  };
}
