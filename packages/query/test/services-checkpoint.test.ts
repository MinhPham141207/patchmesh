import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type {
  EventId,
  FileReadEvent,
  ProtocolEvent,
  ResourceId,
  ResourceVersion,
  RepositoryId,
  ToolRequestedEvent,
  WorktreeId,
  WorkspaceId,
} from "patchmesh-protocol";
import { clearProjectionCacheStats, projectionCacheStats, SqliteEventStore } from "patchmesh-storage";
import { createReadServices } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "patchmesh-query-checkpoint-"));
  dirs.push(dir);
  return join(dir, "ledger.db");
}

const repositoryId = "repo_11111111-1111-4111-8111-111111111111" as RepositoryId;
const workspaceId = "ws_22222222-2222-4222-8222-222222222222" as WorkspaceId;
const worktreeId = "wt_33333333-3333-4333-8333-333333333333" as WorktreeId;
const resourceId = `res_${"a".repeat(64)}` as ResourceId;

const request: ToolRequestedEvent = {
  schemaVersion: 1,
  eventId: "evt_00000000000000000000000000000001" as EventId,
  eventType: "tool.requested",
  source: { kind: "gateway", sourceId: "source_gateway", instanceId: "11111111-1111-4111-8111-111111111111" },
  timestamp: "2026-08-08T00:00:00.000Z",
  repositoryId,
  workspaceId,
  worktreeId,
  agentId: "agent_agent-a",
  taskId: null,
  correlationId: "corr_00000000000000000000000000000001",
  causationId: null,
  sourceSequence: 0,
  payload: { toolName: "read_file", operation: "read src/example.ts", targetResourceId: resourceId, opaque: false },
};

const readVersion: ResourceVersion = {
  resourceId,
  domain: { repositoryId, workspaceId, worktreeId },
  kind: "content_hash",
  value: "hash",
  evidenceEventIds: ["evt_00000000000000000000000000000002" as EventId],
};

const read: FileReadEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000002" as EventId,
  eventType: "file.read",
  correlationId: "corr_00000000000000000000000000000002",
  sourceSequence: null,
  agentId: null,
  taskId: null,
  payload: {
    resource: { resourceId, repositoryId, kind: "file", locator: "src/example.ts" },
    version: readVersion,
    access: "read",
  },
};

/** A real ledger file on disk, the shape hosts hand to `ledgerPath`. */
function buildFixtureLedger(): string {
  const path = tempLedgerPath();
  const store = SqliteEventStore.open(path);
  try {
    store.append(request);
    store.append(read);
  } finally {
    store.close();
  }
  return path;
}

function withReadServices<T>(ledgerPath: string, extraOptions: object, run: (services: ReturnType<typeof createReadServices>) => T): T {
  const store = SqliteEventStore.open(ledgerPath);
  try {
    return run(createReadServices({ reader: store, ...extraOptions }));
  } finally {
    store.close();
  }
}

test("status via checkpoint matches status via direct replay", () => {
  const ledgerPath = buildFixtureLedger();
  const direct = withReadServices(ledgerPath, {}, (services) => services.getStatus());
  clearProjectionCacheStats();
  const cached = withReadServices(ledgerPath, { ledgerPath }, (services) => services.getStatus());
  assert.equal(projectionCacheStats().fullRebuilds, 1);
  assert.deepEqual(cached, direct);
});

test("checkpoint-served graph views match direct replay", () => {
  const ledgerPath = buildFixtureLedger();
  withReadServices(ledgerPath, { ledgerPath }, (cached) => {
    // First call rebuilds; later calls serve from or extend the checkpoint just written.
    return withReadServices(ledgerPath, {}, (direct) => {
      assert.deepEqual(cached.getGraph(), direct.getGraph());
      assert.deepEqual(cached.listAgents(), direct.listAgents());
      assert.deepEqual(cached.listFindings(), direct.listFindings());
      assert.deepEqual(cached.getGraph(), direct.getGraph());
    });
  });
});

test("verifyReplay routes around the checkpoint", () => {
  const ledgerPath = buildFixtureLedger();
  clearProjectionCacheStats();
  const verified = withReadServices(ledgerPath, { ledgerPath, verifyReplay: true }, (services) => services.getStatus());
  assert.equal(projectionCacheStats().fullRebuilds, 0);
  const direct = withReadServices(ledgerPath, {}, (services) => services.getStatus());
  assert.deepEqual(verified, direct);
});
