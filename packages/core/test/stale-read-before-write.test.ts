import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectStaleReadBeforeWrite,
  type DependentWriteEvidence,
  type ResourceReadEvidence,
} from "../src/index.js";

const resourceId = `res_${"b".repeat(64)}`;
const writtenResourceId = `res_${"c".repeat(64)}`;
const domain = {
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_11111111-1111-4111-8111-111111111111",
  worktreeId: "wt_11111111-1111-4111-8111-111111111111",
};

const read: ResourceReadEvidence = {
  eventId: "evt_00000000000000000000000000000001",
  taskId: "task_a",
  resourceId,
  version: {
    resourceId,
    domain,
    kind: "content_hash",
    value: "sha256:before",
    evidenceEventIds: ["evt_00000000000000000000000000000001"],
  },
  coverageId: "coverage_read",
};

const current = (value: string) => ({
  resourceId,
  domain: { ...domain },
  kind: "content_hash" as const,
  value,
  evidenceEventIds: ["evt_00000000000000000000000000000002"],
});

const write = (dependsOnReadEventId = read.eventId): DependentWriteEvidence => ({
  eventId: "evt_00000000000000000000000000000003",
  dependencyId: "dep_task_a_resource_b",
  taskId: "task_a",
  resourceId,
  dependsOnReadEventId,
  coverageId: "coverage_write",
});

test("reports a write that explicitly depends on a stale read", () => {
  const result = detectStaleReadBeforeWrite(read, current("sha256:after"), write());

  assert.equal(result?.findingType, "stale_read_before_write");
  assert.deepEqual(result?.evidence.dependencyIds, ["dep_task_a_resource_b"]);
  assert.deepEqual(result?.evidence.evidenceEventIds, [
    "evt_00000000000000000000000000000001",
    "evt_00000000000000000000000000000002",
    "evt_00000000000000000000000000000003",
  ]);
});

test("reports a dependent write in another resource against a cross-worktree candidate", () => {
  const crossWorktreeCurrent = {
    ...current("sha256:after"),
    domain: { ...domain, worktreeId: "wt_22222222-2222-4222-8222-222222222222" },
  };
  const dependentWrite = { ...write(), resourceId: writtenResourceId };

  assert.equal(
    detectStaleReadBeforeWrite(read, crossWorktreeCurrent, dependentWrite)?.findingType,
    "stale_read_before_write",
  );
});

test("does not report current reads or writes without an explicit read dependency", () => {
  assert.equal(detectStaleReadBeforeWrite(read, current("sha256:before"), write()), null);
  assert.equal(
    detectStaleReadBeforeWrite(read, current("sha256:after"), write("evt_00000000000000000000000000000009")),
    null,
  );
});
