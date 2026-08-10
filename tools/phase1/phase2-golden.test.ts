import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
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
import type { RepositoryId, WorktreeId } from "@patchmesh/protocol";
import { withTemporaryDatabase, withTemporaryDirectory } from "./test-support.js";

const execFile = promisify(execFileCallback);

const repositoryId = "repo_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RepositoryId;
const workspaceId = "ws_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const apiResourceId = fileResourceId(repositoryId, "src/api.ts");

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
  };
}

const editCall: McpToolCall = {
  toolName: "edit_file",
  operation: "edit src/api.ts",
  targetResourceId: apiResourceId,
  opaque: false,
};

test("real MCP calls across linked worktrees produce a covered same-symbol finding", async () => {
  await withTemporaryDirectory("patchmesh-phase2-golden-", async (root) => {
    const [producerWorktree, consumerWorktree] = await createLinkedWorktrees(root);
    await withTemporaryDatabase(async (databasePath) => {
      const store = SqliteEventStore.open(databasePath);
      try {
        const producer = await createProxy(store, [10, 11, 12, 13]).execute(
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
        const consumer = await createProxy(store, [20, 21, 22, 23]).execute(
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
        assert.equal(producer.coverage?.presentation, "sufficient");
        assert.equal(consumer.coverage?.presentation, "sufficient");
        assert.equal(graph.coverage.filter((coverage) => coverage.presentation === "sufficient").length, 2);
        assert.equal(events.filter((event) => event.eventType === "file.changed").length, 2);
        assert.equal(events.filter((event) => event.eventType === "symbol.changed").length, 2);

        const records = createPhase2RuntimeRecords(events);
        assert.equal(records.length, 1);
        assert.equal(records[0]?.finding.payload.finding.findingType, "same_symbol_overlap");
        assert.equal(records[0]?.decision.payload.decision.gatewayDirective, "allow_with_notice");

        for (const record of records) {
          assert.equal(store.append(record.finding).status, "inserted");
          assert.equal(store.append(record.decision).status, "inserted");
        }
        const projected = projectWorkGraph(store.read()).snapshot;
        assert.equal(projected.findings.length, 1);
        assert.equal(projected.decisions.length, 1);
      } finally {
        store.close();
      }
    });
  });
});
