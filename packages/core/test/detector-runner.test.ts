import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runExportedContractInvalidationDetector,
  runSameSymbolDetector,
  runStaleReadBeforeWriteDetector,
  type ConsumerContractDependencyEvidence,
  type DependentWriteEvidence,
  type ExportedContractChangeEvidence,
  type ResourceReadEvidence,
  type SymbolChangeEvidence,
} from "../src/index.js";

const resourceId = `res_${"a".repeat(64)}`;
const worktreeId = "wt_11111111-1111-4111-8111-111111111111";
const targetSnapshot = { targetSnapshotId: `snapshot_${"a".repeat(64)}` as const, integrationTargetId: "target_main" as const, repositoryId: "repo_11111111-1111-4111-8111-111111111111" as const, kind: "branch" as const, locator: "main", baseCommit: "a".repeat(40), candidateIds: [], digest: "a".repeat(64) };

function change(suffix: string, taskId: string, changeWorktreeId = worktreeId): SymbolChangeEvidence {
  const eventId = `evt_${suffix.padStart(32, "0")}`;
  return {
    eventId,
    resourceId,
    version: {
      resourceId,
      domain: {
        repositoryId: "repo_11111111-1111-4111-8111-111111111111",
        workspaceId: "ws_11111111-1111-4111-8111-111111111111",
        worktreeId: changeWorktreeId,
      },
      kind: "content_hash",
      value: `sha256:${suffix}`,
      evidenceEventIds: [eventId],
    },
    agentId: `agent_${taskId}`,
    taskId,
    worktreeId: changeWorktreeId,
    coverageId: `coverage_${suffix}`,
    targetSnapshot,
    concurrencyEventId: "evt_00000000000000000000000000000009",
    concurrencyCoverageId: "coverage_concurrency",
  };
}

test("runs same-symbol detection deterministically and deduplicates repeated evidence", () => {
  const first = change("1", "task_a");
  const second = change("2", "task_b", "wt_22222222-2222-4222-8222-222222222222");

  const forward = runSameSymbolDetector([first, second, first]);
  const reversed = runSameSymbolDetector([second, first]);

  assert.equal(forward.length, 1);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward[0]?.evidence.evidenceEventIds, [first.eventId, second.eventId, "evt_00000000000000000000000000000009"]);
});

test("runs stale-read detection deterministically from explicit read dependencies", () => {
  const read: ResourceReadEvidence = {
    eventId: "evt_00000000000000000000000000000003", taskId: "task_a", resourceId,
    version: { resourceId, domain: { repositoryId: "repo_11111111-1111-4111-8111-111111111111", workspaceId: "ws_11111111-1111-4111-8111-111111111111", worktreeId }, kind: "content_hash", value: "sha256:before", evidenceEventIds: ["evt_00000000000000000000000000000003"] },
    coverageId: "coverage_read",
    targetSnapshot,
  };
  const write: DependentWriteEvidence = { eventId: "evt_00000000000000000000000000000004", dependencyId: "dep_stale", taskId: "task_a", resourceId, dependsOnReadEventId: read.eventId, coverageId: "coverage_write", comparisonChangedEventId: "evt_00000000000000000000000000000005", comparisonCoverageId: "coverage_current", targetSnapshot, readTokenDigest: "sha256:token", writeEffectEventId: "evt_00000000000000000000000000000010", writeEffectCoverageId: "coverage_effect", completionEventId: "evt_00000000000000000000000000000011" };
  const current = { ...read.version, eventId: "evt_00000000000000000000000000000005" as const, value: "sha256:after", evidenceEventIds: ["evt_00000000000000000000000000000005"] };

  const forward = runStaleReadBeforeWriteDetector([read, read], [current], [write, write]);
  const reversed = runStaleReadBeforeWriteDetector([read], [current], [write]);

  assert.equal(forward.length, 1);
  assert.deepEqual(forward, reversed);
});

test("runs contract invalidation deterministically for known consumers", () => {
  const contractResourceId = `res_${"c".repeat(64)}`;
  const domain = { repositoryId: "repo_11111111-1111-4111-8111-111111111111", workspaceId: "ws_11111111-1111-4111-8111-111111111111", worktreeId };
  const before = { resourceId: contractResourceId, domain, kind: "content_hash" as const, value: "sha256:before", evidenceEventIds: ["evt_00000000000000000000000000000006"] };
  const change: ExportedContractChangeEvidence = { eventId: "evt_00000000000000000000000000000006", contractResourceId, beforeVersion: before, afterVersion: { ...before, value: "sha256:after", evidenceEventIds: ["evt_00000000000000000000000000000007"] }, breaking: true, coverageId: "coverage_contract", targetSnapshot };
  const consumer: ConsumerContractDependencyEvidence = { eventId: "evt_00000000000000000000000000000008", dependencyId: "dep_contract", contractResourceId, consumerResourceId: `res_${"d".repeat(64)}`, affectedTaskId: "task_b", observedContractVersion: before, coverageId: "coverage_consumer", targetSnapshot };

  const forward = runExportedContractInvalidationDetector([change, change], [consumer, consumer]);
  const reversed = runExportedContractInvalidationDetector([change], [consumer]);

  assert.equal(forward.length, 1);
  assert.deepEqual(forward, reversed);
});
