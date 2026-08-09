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

function change(suffix: string, taskId: string): SymbolChangeEvidence {
  const eventId = `evt_${suffix.padStart(32, "0")}`;
  return {
    eventId,
    resourceId,
    version: {
      resourceId,
      domain: {
        repositoryId: "repo_11111111-1111-4111-8111-111111111111",
        workspaceId: "ws_11111111-1111-4111-8111-111111111111",
        worktreeId,
      },
      kind: "content_hash",
      value: `sha256:${suffix}`,
      evidenceEventIds: [eventId],
    },
    agentId: `agent_${taskId}`,
    taskId,
    worktreeId,
    coverageId: `coverage_${suffix}`,
  };
}

test("runs same-symbol detection deterministically and deduplicates repeated evidence", () => {
  const first = change("1", "task_a");
  const second = change("2", "task_b");

  const forward = runSameSymbolDetector([first, second, first]);
  const reversed = runSameSymbolDetector([second, first]);

  assert.equal(forward.length, 1);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward[0]?.evidence.evidenceEventIds, [first.eventId, second.eventId]);
});

test("runs stale-read detection deterministically from explicit read dependencies", () => {
  const read: ResourceReadEvidence = {
    eventId: "evt_00000000000000000000000000000003", taskId: "task_a", resourceId,
    version: { resourceId, domain: { repositoryId: "repo_11111111-1111-4111-8111-111111111111", workspaceId: "ws_11111111-1111-4111-8111-111111111111", worktreeId }, kind: "content_hash", value: "sha256:before", evidenceEventIds: ["evt_00000000000000000000000000000003"] },
    coverageId: "coverage_read",
  };
  const write: DependentWriteEvidence = { eventId: "evt_00000000000000000000000000000004", dependencyId: "dep_stale", taskId: "task_a", resourceId, dependsOnReadEventId: read.eventId, coverageId: "coverage_write" };
  const current = { ...read.version, value: "sha256:after", evidenceEventIds: ["evt_00000000000000000000000000000005"] };

  const forward = runStaleReadBeforeWriteDetector([read, read], [current], [write, write]);
  const reversed = runStaleReadBeforeWriteDetector([read], [current], [write]);

  assert.equal(forward.length, 1);
  assert.deepEqual(forward, reversed);
});

test("runs contract invalidation deterministically for known consumers", () => {
  const contractResourceId = `res_${"c".repeat(64)}`;
  const domain = { repositoryId: "repo_11111111-1111-4111-8111-111111111111", workspaceId: "ws_11111111-1111-4111-8111-111111111111", worktreeId };
  const before = { resourceId: contractResourceId, domain, kind: "content_hash" as const, value: "sha256:before", evidenceEventIds: ["evt_00000000000000000000000000000006"] };
  const change: ExportedContractChangeEvidence = { eventId: "evt_00000000000000000000000000000006", contractResourceId, beforeVersion: before, afterVersion: { ...before, value: "sha256:after", evidenceEventIds: ["evt_00000000000000000000000000000007"] }, breaking: true, coverageId: "coverage_contract" };
  const consumer: ConsumerContractDependencyEvidence = { eventId: "evt_00000000000000000000000000000008", dependencyId: "dep_contract", contractResourceId, consumerResourceId: `res_${"d".repeat(64)}`, affectedTaskId: "task_b", observedContractVersion: before, coverageId: "coverage_consumer" };

  const forward = runExportedContractInvalidationDetector([change, change], [consumer, consumer]);
  const reversed = runExportedContractInvalidationDetector([change], [consumer]);

  assert.equal(forward.length, 1);
  assert.deepEqual(forward, reversed);
});
