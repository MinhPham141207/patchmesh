import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  McpProxy,
  type McpCallContext,
  type McpToolCall,
} from "@patchmesh/adapters";
import { createPhase2RuntimeRecords } from "@patchmesh/core";
import {
  fileResourceId,
  NodeObservationBoundary,
} from "@patchmesh/observation";
import { projectWorkGraph, SqliteEventStore } from "@patchmesh/storage";
import type { RepositoryId, TargetSnapshot, WorktreeId } from "@patchmesh/protocol";
import { withTemporaryDatabase, withTemporaryDirectory } from "./test-support.js";

const execFile = promisify(execFileCallback);

const repositoryId = "repo_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RepositoryId;
const workspaceId = "ws_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const apiResourceId = fileResourceId(repositoryId, "src/api.ts");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function targetSnapshot(): TargetSnapshot {
  const binding = {
    integrationTargetId: "target_phase2" as const,
    repositoryId,
    kind: "branch" as const,
    locator: "main",
    baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    candidateIds: [] as readonly string[],
  };
  const digest = createHash("sha256").update(canonicalJson(binding)).digest("hex");
  return {
    ...binding,
    targetSnapshotId: `snapshot_${digest}`,
    digest,
  };
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

async function createLinkedWorktrees(root: string): Promise<readonly [string, string]> {
  await runGit(root, "init", "-b", "main");
  await runGit(root, "config", "user.email", "phase2@example.invalid");
  await runGit(root, "config", "user.name", "PatchMesh Phase 2");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "api.ts"), "export function calculateTotal(value: number): number { return value; }\n");
  await runGit(root, "add", ".");
  await runGit(root, "commit", "-m", "phase 2 golden baseline");

  const producerWorktree = join(root, "producer-worktree");
  const consumerWorktree = join(root, "consumer-worktree");
  await runGit(root, "worktree", "add", "--detach", producerWorktree, "HEAD");
  await runGit(root, "worktree", "add", "--detach", consumerWorktree, "HEAD");
  return [producerWorktree, consumerWorktree];
}

function eventId(number: number): `evt_${string}` {
  return `evt_${number.toString(16).padStart(32, "0")}`;
}

function createProxy(store: SqliteEventStore, ids: number[]): McpProxy {
  return new McpProxy({
    eventStore: store,
    observer: new NodeObservationBoundary({
      source: {
        kind: "watcher",
        sourceId: "source_phase2_watcher",
        instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
      quiescenceMs: 100,
    }),
    phase2SourceAnalysis: {
      source: {
        kind: "analyzer",
        sourceId: "source_phase2_typescript",
        instanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
      analyzer: { analyzerId: "analyzer_typescript", version: "1" },
      configuration: { parser: "typescript" },
      integrationTarget: "main",
    },
    proofAuthority: {
      authoritativeIdentity: true,
      taskLifecycle: true,
      integrationTargetSnapshot: true,
      observedReadVersion: true,
      dependentWriteToken: true,
      exactReportedEffects: true,
    },
    createEventId: () => eventId(ids.shift() ?? 99),
    now: () => "2026-08-10T00:00:00.000Z",
  });
}

function createContext(
  workspaceRoot: string,
  worktreeId: WorktreeId,
  agentId: "agent_producer" | "agent_consumer",
  taskId: "task_producer" | "task_consumer",
  correlationId: `corr_${string}`,
  sourceSequence: number,
): McpCallContext {
  return {
    source: {
      kind: "adapter",
      sourceId: "source_phase2_mcp",
      instanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    },
    repositoryId,
    workspaceId,
    worktreeId,
    workspaceRoot,
    agentId,
    taskId,
    correlationId,
    causationId: null,
    requestSourceSequence: sourceSequence,
    completionSourceSequence: sourceSequence + 1,
    targetSnapshot: targetSnapshot(),
  };
}

const editCall: McpToolCall = {
  toolName: "edit_file",
  operation: "edit src/api.ts",
  targetResourceId: apiResourceId,
  opaque: false,
};

test("sequential MCP calls across linked worktrees do not manufacture concurrency evidence", async () => {
  await withTemporaryDirectory("patchmesh-phase2-golden-", async (root) => {
    const [producerWorktree, consumerWorktree] = await createLinkedWorktrees(root);
    await withTemporaryDatabase(async (databasePath) => {
      const store = SqliteEventStore.open(databasePath);
      let producerProxy: McpProxy | null = null;
      let consumerProxy: McpProxy | null = null;
      try {
        producerProxy = createProxy(store, [10, 11, 12, 13, 14]);
        const producer = await producerProxy.execute(
          editCall,
          createContext(
            producerWorktree,
            "wt_11111111-1111-4111-8111-111111111111",
            "agent_producer",
            "task_producer",
            "corr_11111111111111111111111111111111",
            0,
          ),
          async () => {
            await writeFile(join(producerWorktree, "src", "api.ts"), "export function calculateTotal(value: number, tax = 0): number { return value + tax; }\n");
            return {
              outcome: "succeeded",
              value: true,
              exitCode: 0,
              effectResourceIds: [apiResourceId],
            };
          },
        );
        consumerProxy = createProxy(store, [20, 21, 22, 23, 24]);
        const consumer = await consumerProxy.execute(
          editCall,
          createContext(
            consumerWorktree,
            "wt_22222222-2222-4222-8222-222222222222",
            "agent_consumer",
            "task_consumer",
            "corr_22222222222222222222222222222222",
            2,
          ),
          async () => {
            await writeFile(join(consumerWorktree, "src", "api.ts"), "export function calculateTotal(value: number, currency: string): number { return value; }\n");
            return {
              outcome: "succeeded",
              value: true,
              exitCode: 0,
              effectResourceIds: [apiResourceId],
            };
          },
        );

        const events = store.read();
        const graph = projectWorkGraph(events).snapshot;
        assert.equal(producer.coverage?.presentation, "degraded", JSON.stringify(producer.coverage?.gaps));
        assert.equal(consumer.coverage?.presentation, "degraded", JSON.stringify(consumer.coverage?.gaps));
        assert.equal(graph.coverage.filter((coverage) => coverage.presentation === "degraded").length, 2);
        assert.equal(events.filter((event) => event.eventType === "file.changed").length, 2);
        assert.equal(events.filter((event) => event.eventType === "symbol.changed").length, 2);

        const records = createPhase2RuntimeRecords(events);
        assert.equal(events.some((event) => event.eventType === "task.concurrency.observed"), false);
        assert.equal(records.length, 0);
        const projected = projectWorkGraph(store.read()).snapshot;
        assert.equal(projected.findings.length, 0);
        assert.equal(projected.decisions.length, 0);
      } finally {
        await producerProxy?.dispose();
        await consumerProxy?.dispose();
        store.close();
      }
    });
  });
});

test("real linked worktrees produce a durable exported-contract invalidation", async () => {
  await withTemporaryDirectory("patchmesh-phase2-contract-golden-", async (root) => {
    await runGit(root, "init", "-b", "main");
    await runGit(root, "config", "user.email", "phase2@example.invalid");
    await runGit(root, "config", "user.name", "PatchMesh Phase 2");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "api.ts"), "export function calculateTotal(value: number): number { return value; }\n");
    await writeFile(join(root, "src", "consumer.ts"), 'import { calculateTotal } from "./api";\nexport function use(value: number): number { return calculateTotal(value); }\n');
    await runGit(root, "add", ".");
    await runGit(root, "commit", "-m", "phase 2 contract baseline");

    await withTemporaryDatabase(async (databasePath) => {
      const store = SqliteEventStore.open(databasePath);
      let historyProxy: McpProxy | null = null;
      let consumerProxy: McpProxy | null = null;
      let producerProxy: McpProxy | null = null;
      try {
        const apiResourceId = fileResourceId(repositoryId, "src/api.ts");
        const consumerResourceId = fileResourceId(repositoryId, "src/consumer.ts");
        historyProxy = createProxy(store, [30, 31, 32, 33, 34]);
        const history = await historyProxy.execute(
          { ...editCall, targetResourceId: apiResourceId },
          createContext(
            root,
            "wt_33333333-3333-4333-8333-333333333333",
            "agent_producer",
            "task_producer",
            "corr_33333333333333333333333333333333",
            0,
          ),
          async () => {
            await writeFile(join(root, "src", "api.ts"), "export function calculateTotal(value: number, tax?: number): number { return value + (tax ?? 0); }\n");
            return { outcome: "succeeded", value: true, exitCode: 0, effectResourceIds: [apiResourceId] };
          },
        );
        assert.equal(history.coverage?.presentation, "sufficient");
        await runGit(root, "add", ".");
        await runGit(root, "commit", "-m", "phase 2 contract v1");

        const producerWorktree = join(root, "contract-producer-worktree");
        const consumerWorktree = join(root, "contract-consumer-worktree");
        await runGit(root, "worktree", "add", "--detach", producerWorktree, "HEAD");
        await runGit(root, "worktree", "add", "--detach", consumerWorktree, "HEAD");

        consumerProxy = createProxy(store, [40, 41, 42, 43, 44, 45, 46]);
        const consumer = await consumerProxy.execute(
          { ...editCall, targetResourceId: consumerResourceId },
          createContext(
            consumerWorktree,
            "wt_22222222-2222-4222-8222-222222222222",
            "agent_consumer",
            "task_consumer",
            "corr_22222222222222222222222222222222",
            2,
          ),
          async () => {
            await writeFile(join(consumerWorktree, "src", "consumer.ts"), 'import { calculateTotal } from "./api";\nexport function use(value: number): number { return calculateTotal(value) + 1; }\n');
            return { outcome: "succeeded", value: true, exitCode: 0, effectResourceIds: [consumerResourceId] };
          },
        );
        assert.equal(consumer.coverage?.presentation, "sufficient");

        // Bind the breaking change to the exact content hash that the
        // persisted V3 predecessor proved in the linked checkout.
        await writeFile(join(producerWorktree, "src", "api.ts"), "export function calculateTotal(value: number, tax?: number): number { return value + (tax ?? 0); }\n");
        producerProxy = createProxy(store, [50, 51, 52, 53, 54]);
        const producer = await producerProxy.execute(
          { ...editCall, targetResourceId: apiResourceId },
          createContext(
            producerWorktree,
            "wt_11111111-1111-4111-8111-111111111111",
            "agent_producer",
            "task_producer",
            "corr_11111111111111111111111111111111",
            4,
          ),
          async () => {
            await writeFile(join(producerWorktree, "src", "api.ts"), "export function calculateTotal(value: string): number { return Number(value); }\n");
            return { outcome: "succeeded", value: true, exitCode: 0, effectResourceIds: [apiResourceId] };
          },
        );
        assert.equal(producer.coverage?.presentation, "sufficient");

        const events = store.read();
        assert.equal(events.filter((event) => event.eventType === "evidence.derived").length >= 4, true);
        assert.equal(events.some((event) => event.eventType === "dependency.changed"), true);
        const records = createPhase2RuntimeRecords(events);
        const contractRecords = records.filter((record) => record.finding.payload.finding.findingType === "exported_contract_invalidation");
        assert.equal(contractRecords.length, 1);
        assert.equal(contractRecords[0]?.decision.payload.decision.gatewayDirective, "allow_with_notice");
      } finally {
        await historyProxy?.dispose();
        await consumerProxy?.dispose();
        await producerProxy?.dispose();
        store.close();
      }
    });
  });
});
