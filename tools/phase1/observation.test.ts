import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  McpProxy,
  type McpCallContext,
  type McpToolCall,
} from "@patchmesh/adapters";
import { NodeObservationBoundary, sanitizeDiagnostic } from "@patchmesh/observation";
import { SqliteEventStore } from "@patchmesh/storage";
import {
  consumerAgentId,
  consumerTaskId,
  consumerWorktreeId,
  producerAgentId,
  producerTaskId,
  producerWorktreeId,
  repositoryId,
  workspaceId,
} from "./fixtures.js";
import { assertNoPhase2Output, withTemporaryDatabase, withTemporaryDirectory } from "./test-support.js";

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

async function createRepository(root: string): Promise<string> {
  await runGit(root, "init", "-b", "main");
  await runGit(root, "config", "user.email", "m7@example.invalid");
  await runGit(root, "config", "user.name", "PatchMesh M7");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "contracts.ts"), "export function calculateTotal(value: number): number { return value; }\n");
  await writeFile(join(root, "src", "cart.ts"), "import { calculateTotal } from './contracts';\nexport const total = calculateTotal(1);\n");
  await runGit(root, "add", ".");
  await runGit(root, "commit", "-m", "initial M7 fixture");
  const worktree = join(root, "consumer-worktree");
  await runGit(root, "worktree", "add", "--detach", worktree, "HEAD");
  return worktree;
}

function eventId(number: number): `evt_${string}` {
  return `evt_${number.toString(16).padStart(32, "0")}`;
}

function createProxy(store: SqliteEventStore, workspaceRoot: string, ids: number[], opaque = false): McpProxy {
  return new McpProxy({
    eventStore: store,
    observer: new NodeObservationBoundary({
      source: {
        kind: "watcher",
        sourceId: "source_m7_observer",
        instanceId: "66666666-6666-4666-8666-666666666666",
      },
    }),
    createEventId: () => eventId(ids.shift() ?? 99),
    now: () => "2026-08-08T00:00:00.000Z",
    createCorrelationId: () => `corr_${"c".repeat(32)}`,
  });
}

function createContext(workspaceRoot: string, interrupted = false): McpCallContext {
  return {
    source: {
      kind: "adapter",
      sourceId: "source_m7_mcp",
      instanceId: "77777777-7777-4777-8777-777777777777",
    },
    repositoryId,
    workspaceId,
    worktreeId: producerWorktreeId,
    workspaceRoot,
    agentId: interrupted ? consumerAgentId : producerAgentId,
    taskId: interrupted ? consumerTaskId : producerTaskId,
    correlationId: `corr_${interrupted ? "d" : "e"}`.padEnd(37, "0") as `corr_${string}`,
    causationId: null,
    requestSourceSequence: 0,
    completionSourceSequence: 1,
  };
}

const editCall: McpToolCall = {
  toolName: "edit_file",
  operation: "edit src/contracts.ts",
  targetResourceId: null,
  opaque: false,
};

test("real MCP observation persists actual Git file effects and links completion evidence", async () => {
  await withTemporaryDirectory("patchmesh-m7-git-", async (root) => {
    const worktree = await createRepository(root);
    await withTemporaryDatabase(async (databasePath) => {
      const store = SqliteEventStore.open(databasePath);
      let proxy: McpProxy | null = null;
      try {
        proxy = createProxy(store, worktree, [10, 11, 12]);
        const result = await proxy.execute(
          editCall,
          { ...createContext(worktree), workspaceRoot: worktree },
          async () => {
            await writeFile(join(worktree, "src", "contracts.ts"), "export function calculateTotal(value: number, tax = 0): number { return value + tax; }\n");
            return { outcome: "succeeded", value: true, exitCode: 0 };
          },
        );
        const events = store.read();
        assert.deepEqual(events.map((event) => event.eventType), ["tool.requested", "file.changed", "tool.completed"]);
        const effect = events[1];
        const completion = events[2];
        if (effect?.eventType !== "file.changed" || completion?.eventType !== "tool.completed") {
          throw new Error("expected persisted file effect and completion");
        }
        assert.equal(effect.payload.resource.locator, "src/contracts.ts");
        assert.deepEqual(completion.payload.effectEventIds, [effect.eventId]);
        assert.equal(result.coverage?.presentation, "degraded");
        assert.ok(result.coverage?.modes.includes("verified"));
        assert.ok(result.observationDiagnostics.some(
          (gap) => gap.kind === "unverified" && gap.scope === "tool.effects",
        ));
        assertNoPhase2Output(events);
      } finally {
        await proxy?.dispose();
        store.close();
      }
    });
  });
});

test("failed and interrupted MCP calls persist explicit non-success outcomes", async () => {
  await withTemporaryDirectory("patchmesh-m7-git-", async (root) => {
    await createRepository(root);
    await withTemporaryDatabase(async (databasePath) => {
      const failedStore = SqliteEventStore.open(databasePath);
      let failedProxy: McpProxy | null = null;
      try {
        failedProxy = createProxy(failedStore, root, [20, 21]);
        const failed = await failedProxy.execute(
          editCall,
          createContext(root),
          async () => ({ outcome: "failed", error: new Error("password=do-not-persist"), exitCode: 1 }),
        );
        assert.equal(failed.execution.outcome, "failed");
        assert.equal(failedStore.read().at(-1)?.eventType, "tool.completed");
        const completion = failedStore.read().at(-1);
        if (completion?.eventType !== "tool.completed") throw new Error("expected failed completion");
        assert.equal(completion.payload.outcome, "failed");
      } finally {
        await failedProxy?.dispose();
        failedStore.close();
      }
    });
  });

  await withTemporaryDirectory("patchmesh-m7-git-", async (root) => {
    await createRepository(root);
    await withTemporaryDatabase(async (databasePath) => {
      const store = SqliteEventStore.open(databasePath);
      let proxy: McpProxy | null = null;
      try {
        const controller = new AbortController();
        controller.abort();
        proxy = createProxy(store, root, [30, 31]);
        const interrupted = await proxy.execute(
          editCall,
          createContext(root, true),
          async (signal) => {
            if (signal.aborted) throw new Error("aborted execution");
            return { outcome: "succeeded", value: true, exitCode: 0 };
          },
          controller.signal,
        );
        assert.equal(interrupted.execution.outcome, "interrupted");
        const completion = store.read().at(-1);
        if (completion?.eventType !== "tool.completed") throw new Error("expected interrupted completion");
        assert.equal(completion.payload.outcome, "interrupted");
      } finally {
        await proxy?.dispose();
        store.close();
      }
    });
  });
});

test("opaque shell effects produce degraded coverage instead of transparent attribution", async () => {
  await withTemporaryDirectory("patchmesh-m7-git-", async (root) => {
    await createRepository(root);
    await withTemporaryDatabase(async (databasePath) => {
      const store = SqliteEventStore.open(databasePath);
      let proxy: McpProxy | null = null;
      try {
        proxy = createProxy(store, root, [40, 41, 42]);
        const result = await proxy.execute(
          {
            toolName: "run_shell",
            operation: "node -e file mutation",
            targetResourceId: null,
            opaque: true,
          },
          createContext(root),
          async () => {
            await execFile(process.execPath, ["-e", `require('node:fs').appendFileSync(${JSON.stringify(join(root, "src", "cart.ts"))}, "// opaque\\n")`], { windowsHide: true });
            return { outcome: "succeeded", value: true, exitCode: 0 };
          },
        );
        assert.equal(result.coverage?.presentation, "degraded");
        assert.ok(result.observationDiagnostics.some((gap) => gap.kind === "opaque"));
      } finally {
        await proxy?.dispose();
        store.close();
      }
    });
  });
});

test("diagnostic redaction removes credential-shaped values", () => {
  const sanitized = sanitizeDiagnostic("password=secret access_token=abc Authorization: Bearer xyz");
  assert.equal(sanitized.includes("secret"), false);
  assert.equal(sanitized.includes("abc"), false);
  assert.equal(sanitized.includes("xyz"), false);
  assert.match(sanitized, /<redacted>/);
});
