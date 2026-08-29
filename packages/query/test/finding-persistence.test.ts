import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteEventStore } from "patchmesh-storage";
import { persistFindings } from "../src/overlap.js";

test("persistFindings creates finding.created events from overlaps", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-findings-"));
  try {
    const dbPath = join(root, "ledger.db");
    const store = SqliteEventStore.open(dbPath);

    const overlaps = [{
      logicalPath: "src/index.ts",
      tasks: [
        { taskId: "task_1", agentId: "agent_a", at: "2026-08-29T00:00:00Z", changeKind: "modified", worktreeId: null },
        { taskId: "task_2", agentId: "agent_b", at: "2026-08-29T00:01:00Z", changeKind: "modified", worktreeId: null },
      ],
      contention: {
        earlierWorkerAgentId: "agent_a",
        earlierWriteAt: "2026-08-29T00:00:00Z",
        earlierWorkerLastActiveAt: "2026-08-29T00:02:00Z",
        earlierWorkerActiveAt: "2026-08-29T00:00:00Z",
        earlierWorkerIdleGapMs: 60000,
        laterWorkerAgentId: "agent_b",
        laterWriteAt: "2026-08-29T00:01:00Z",
      },
    }];

    persistFindings(dbPath, overlaps, "repo_test123");

    const findings = store.read({ eventTypes: ["finding.created"] }, { validate: false });
    assert.equal(findings.length, 1);
    const finding = findings[0] as any;
    assert.equal(finding.payload.filePath, "src/index.ts");
    assert.ok(finding.eventId.startsWith("evt_"));
    store.close();
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});

test("persistFindings deduplicates by findingId", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-findings-dedup-"));
  try {
    const dbPath = join(root, "ledger.db");
    const store = SqliteEventStore.open(dbPath);

    const overlaps = [{
      logicalPath: "src/index.ts",
      tasks: [
        { taskId: "task_1", agentId: "agent_a", at: "2026-08-29T00:00:00Z", changeKind: "modified", worktreeId: null },
        { taskId: "task_2", agentId: "agent_b", at: "2026-08-29T00:01:00Z", changeKind: "modified", worktreeId: null },
      ],
      contention: {
        earlierWorkerAgentId: "agent_a",
        earlierWriteAt: "2026-08-29T00:00:00Z",
        earlierWorkerLastActiveAt: "2026-08-29T00:02:00Z",
        earlierWorkerActiveAt: "2026-08-29T00:00:00Z",
        earlierWorkerIdleGapMs: 60000,
        laterWorkerAgentId: "agent_b",
        laterWriteAt: "2026-08-29T00:01:00Z",
      },
    }];

    persistFindings(dbPath, overlaps, "repo_test123");
    persistFindings(dbPath, overlaps, "repo_test123"); // second call

    const findings = store.read({ eventTypes: ["finding.created"] }, { validate: false });
    assert.equal(findings.length, 1, "duplicate finding should not be created");
    store.close();
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});
