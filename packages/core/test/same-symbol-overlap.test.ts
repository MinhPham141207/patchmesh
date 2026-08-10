import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectSameSymbolOverlap,
  type SymbolChangeEvidence,
} from "../src/index.js";

const evidence = (
  suffix: string,
  options: Partial<SymbolChangeEvidence> = {},
): SymbolChangeEvidence => ({
  eventId: `evt_${suffix.padStart(32, "0")}`,
  resourceId: `res_${"a".repeat(64)}`,
  version: {
    resourceId: `res_${"a".repeat(64)}`,
    domain: {
      repositoryId: "repo_11111111-1111-4111-8111-111111111111",
      workspaceId: "ws_11111111-1111-4111-8111-111111111111",
      worktreeId: "wt_11111111-1111-4111-8111-111111111111",
    },
    kind: "content_hash",
    value: `sha256:${suffix}`,
    evidenceEventIds: [`evt_${suffix.padStart(32, "0")}`],
  },
  agentId: "agent_a",
  taskId: "task_a",
  worktreeId: "wt_11111111-1111-4111-8111-111111111111",
  coverageId: `coverage_${suffix}`,
  integrationTarget: "main",
  concurrencyEventId: "evt_00000000000000000000000000000003",
  concurrencyCoverageId: "coverage_concurrency",
  ...options,
});

test("reports independently attributed changes to the same symbol", () => {
  const candidate = evidence("2", { agentId: "agent_b", taskId: "task_b" });
  const crossWorktreeCandidate: SymbolChangeEvidence = {
    ...candidate,
    worktreeId: "wt_22222222-2222-4222-8222-222222222222",
    version: {
      ...candidate.version,
      domain: { ...candidate.version.domain, worktreeId: "wt_22222222-2222-4222-8222-222222222222" },
    },
  };
  const result = detectSameSymbolOverlap(
    evidence("1"),
    crossWorktreeCandidate,
  );

  assert.deepEqual(result?.evidence.evidenceEventIds, [
    "evt_00000000000000000000000000000001",
    "evt_00000000000000000000000000000002",
    "evt_00000000000000000000000000000003",
  ]);
  assert.equal(result?.findingType, "same_symbol_overlap");
  assert.equal(result?.evidence.affectedTaskId, "task_b");
});

test("reports independently attributed changes from separate worktrees", () => {
  const candidate = evidence("2", { agentId: "agent_b", taskId: "task_b" });
  const crossWorktreeCandidate: SymbolChangeEvidence = {
    ...candidate,
    worktreeId: "wt_22222222-2222-4222-8222-222222222222",
    version: {
      ...candidate.version,
      domain: {
        ...candidate.version.domain,
        worktreeId: "wt_22222222-2222-4222-8222-222222222222",
      },
    },
  };

  assert.equal(detectSameSymbolOverlap(evidence("1"), crossWorktreeCandidate)?.findingType, "same_symbol_overlap");
});

test("does not report shared task changes or incomplete attribution", () => {
  assert.equal(detectSameSymbolOverlap(evidence("1"), evidence("2")), null);
  assert.equal(
    detectSameSymbolOverlap(evidence("1", { agentId: null }), evidence("2", { taskId: "task_b" })),
    null,
  );
});

test("does not report changes from the same worktree", () => {
  const candidate = evidence("2", { agentId: "agent_b", taskId: "task_b" });
  assert.equal(detectSameSymbolOverlap(evidence("1"), candidate), null);
});

test("does not report without the concurrency coverage proof", () => {
  const candidate = evidence("2", {
    agentId: "agent_b",
    taskId: "task_b",
    concurrencyCoverageId: undefined,
    worktreeId: "wt_22222222-2222-4222-8222-222222222222",
  });
  const crossWorktreeCandidate = {
    ...candidate,
    version: { ...candidate.version, domain: { ...candidate.version.domain, worktreeId: candidate.worktreeId } },
  };
  assert.equal(detectSameSymbolOverlap(evidence("1"), crossWorktreeCandidate), null);
});
