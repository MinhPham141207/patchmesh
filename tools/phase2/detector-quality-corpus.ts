import {
  detectExportedContractInvalidation,
  detectSameSymbolOverlap,
  detectStaleReadBeforeWrite,
  type DetectorCorpusCase,
} from "../../packages/core/dist/index.js";
import type { ResourceVersion } from "../../packages/protocol/dist/index.js";

/** Synthetic, reviewable engineering corpus; it is not field-validation data. */
export const syntheticDetectorQualityCorpusVersion = "v1";

const domain = {
  repositoryId: "repo_quality",
  workspaceId: "ws_quality",
  worktreeId: "wt_quality_a",
} as const;

function version(
  resourceId: `res_${string}`,
  value: string | null,
  worktreeId = domain.worktreeId,
): ResourceVersion {
  return {
    resourceId,
    domain: { ...domain, worktreeId },
    kind: "symbol_signature",
    value,
    evidenceEventIds: ["evt_quality_version"],
  };
}

const symbol = "res_quality_symbol" as const;
const contract = "res_quality_contract" as const;

const overlapPositive = detectSameSymbolOverlap(
  { eventId: "evt_overlap_a", resourceId: symbol, version: version(symbol, "a"), agentId: "agent_a", taskId: "task_a", worktreeId: "wt_quality_a", coverageId: "coverage_overlap_a" },
  { eventId: "evt_overlap_b", resourceId: symbol, version: version(symbol, "b", "wt_quality_b"), agentId: "agent_b", taskId: "task_b", worktreeId: "wt_quality_b", coverageId: "coverage_overlap_b" },
);

const staleRead = {
  eventId: "evt_stale_read",
  taskId: "task_stale",
  resourceId: symbol,
  version: version(symbol, "a"),
  coverageId: "coverage_stale_read",
} as const;
const staleWrite = {
  eventId: "evt_stale_write",
  dependencyId: "dep_stale",
  taskId: "task_stale",
  resourceId: symbol,
  dependsOnReadEventId: "evt_stale_read",
  coverageId: "coverage_stale_write",
} as const;

const stalePositive = detectStaleReadBeforeWrite(staleRead, version(symbol, "b"), staleWrite);

const contractChange = {
  eventId: "evt_contract_change",
  contractResourceId: contract,
  beforeVersion: version(contract, "v1"),
  afterVersion: version(contract, "v2"),
  breaking: true,
  coverageId: "coverage_contract_change",
} as const;
const contractConsumer = {
  eventId: "evt_contract_consumer",
  dependencyId: "dep_contract",
  contractResourceId: contract,
  consumerResourceId: "res_quality_consumer",
  affectedTaskId: "task_consumer",
  observedContractVersion: version(contract, "v1"),
  coverageId: "coverage_contract_consumer",
} as const;
const contractPositive = detectExportedContractInvalidation(contractChange, contractConsumer);

/**
 * Every detector has one relevant case and four deliberately non-actionable
 * cases. The negatives cover incomplete, unrelated, current, and non-breaking
 * evidence, so an accepted run means the gate saw both labels for every class.
 */
export const syntheticDetectorQualityCorpus: readonly DetectorCorpusCase[] = [
  { caseId: "v1-overlap-independent-symbol-changes", findingType: "same_symbol_overlap", expectedFinding: true, actualFinding: overlapPositive },
  { caseId: "v1-overlap-same-task", findingType: "same_symbol_overlap", expectedFinding: false, actualFinding: detectSameSymbolOverlap({ eventId: "evt_overlap_same_a", resourceId: symbol, version: version(symbol, "a"), agentId: "agent_a", taskId: "task_a", worktreeId: "wt_quality_a", coverageId: "coverage_overlap_a" }, { eventId: "evt_overlap_same_b", resourceId: symbol, version: version(symbol, "b"), agentId: "agent_b", taskId: "task_a", worktreeId: "wt_quality_b", coverageId: "coverage_overlap_b" }) },
  { caseId: "v1-overlap-same-version", findingType: "same_symbol_overlap", expectedFinding: false, actualFinding: detectSameSymbolOverlap({ eventId: "evt_overlap_version_a", resourceId: symbol, version: version(symbol, "a"), agentId: "agent_a", taskId: "task_a", worktreeId: "wt_quality_a", coverageId: "coverage_overlap_a" }, { eventId: "evt_overlap_version_b", resourceId: symbol, version: version(symbol, "a"), agentId: "agent_b", taskId: "task_b", worktreeId: "wt_quality_b", coverageId: "coverage_overlap_b" }) },
  { caseId: "v1-overlap-different-resource", findingType: "same_symbol_overlap", expectedFinding: false, actualFinding: detectSameSymbolOverlap({ eventId: "evt_overlap_resource_a", resourceId: symbol, version: version(symbol, "a"), agentId: "agent_a", taskId: "task_a", worktreeId: "wt_quality_a", coverageId: "coverage_overlap_a" }, { eventId: "evt_overlap_resource_b", resourceId: "res_quality_other", version: version("res_quality_other", "b"), agentId: "agent_b", taskId: "task_b", worktreeId: "wt_quality_a", coverageId: "coverage_overlap_b" }) },
  { caseId: "v1-overlap-unattributed", findingType: "same_symbol_overlap", expectedFinding: false, actualFinding: detectSameSymbolOverlap({ eventId: "evt_overlap_null_a", resourceId: symbol, version: version(symbol, "a"), agentId: null, taskId: null, worktreeId: "wt_quality_a", coverageId: "coverage_overlap_a" }, { eventId: "evt_overlap_null_b", resourceId: symbol, version: version(symbol, "b"), agentId: "agent_b", taskId: "task_b", worktreeId: "wt_quality_b", coverageId: "coverage_overlap_b" }) },

  { caseId: "v1-stale-explicit-dependent-write", findingType: "stale_read_before_write", expectedFinding: true, actualFinding: stalePositive },
  { caseId: "v1-stale-current-read", findingType: "stale_read_before_write", expectedFinding: false, actualFinding: detectStaleReadBeforeWrite(staleRead, version(symbol, "a"), staleWrite) },
  { caseId: "v1-stale-unlinked-write", findingType: "stale_read_before_write", expectedFinding: false, actualFinding: detectStaleReadBeforeWrite(staleRead, version(symbol, "b"), { ...staleWrite, dependsOnReadEventId: "evt_other_read" }) },
  { caseId: "v1-stale-different-task", findingType: "stale_read_before_write", expectedFinding: false, actualFinding: detectStaleReadBeforeWrite(staleRead, version(symbol, "b"), { ...staleWrite, taskId: "task_other" }) },
  { caseId: "v1-stale-different-resource", findingType: "stale_read_before_write", expectedFinding: false, actualFinding: detectStaleReadBeforeWrite(staleRead, version("res_quality_other", "b"), staleWrite) },

  { caseId: "v1-contract-breaking-known-consumer", findingType: "exported_contract_invalidation", expectedFinding: true, actualFinding: contractPositive },
  { caseId: "v1-contract-non-breaking", findingType: "exported_contract_invalidation", expectedFinding: false, actualFinding: detectExportedContractInvalidation({ ...contractChange, breaking: false }, contractConsumer) },
  { caseId: "v1-contract-current-consumer", findingType: "exported_contract_invalidation", expectedFinding: false, actualFinding: detectExportedContractInvalidation(contractChange, { ...contractConsumer, observedContractVersion: version(contract, "v2") }) },
  { caseId: "v1-contract-unchanged-version", findingType: "exported_contract_invalidation", expectedFinding: false, actualFinding: detectExportedContractInvalidation({ ...contractChange, afterVersion: version(contract, "v1") }, contractConsumer) },
  { caseId: "v1-contract-different-contract", findingType: "exported_contract_invalidation", expectedFinding: false, actualFinding: detectExportedContractInvalidation(contractChange, { ...contractConsumer, contractResourceId: "res_quality_other" }) },
];
