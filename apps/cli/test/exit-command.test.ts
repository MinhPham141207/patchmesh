import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeRepository } from "../src/init.js";
import { exitRepository, renderExit } from "../src/exit.js";
import { runCli } from "../src/main.js";
import type { ReadServices } from "patchmesh-query";

const status = {
  health: "degraded" as const,
  store: { state: "open" as const, replayable: true },
  eventCount: 0,
  eventTypeCounts: {} as never,
  agentCount: 0,
  taskCount: 0,
  nullAttributionEventCount: 0,
  coverage: { presentation: "degraded" as const, modes: ["unknown"], gaps: [] },
  errorCategory: null,
};

const services = {
  getStatus: () => status,
  listAgents: () => ({ agents: [] }),
  listEvents: () => ({ events: [], nextCursor: null, hasMore: false }),
  getGraph: () => ({ snapshot: { nodes: [], edges: [], coverage: [] }, filters: {}, coverageWarnings: [] }),
  listFindings: () => ({ findings: [], coverageWarnings: [] }),
  explainDecision: () => ({
    decision: { decision: { decisionId: "d", findingId: "f", coordinationAction: "record", gatewayDirective: "allow", state: "active", evidenceEventIds: [] }, deliveries: [], feedback: [], eventIds: [] },
    finding: null,
    coverageWarnings: [],
  }),
  followEvents: async function* () {},
} as unknown as ReadServices;

function monorepoCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-exit-"));
  for (const owner of ["recorder", "gateway"]) {
    mkdirSync(join(root, "packages", owner, "dist"), { recursive: true });
  }
  for (const [owner, binary] of [
    ["recorder", "bin.js"], ["recorder", "ingest-bin.js"],
    ["gateway", "session-start-bin.js"], ["gateway", "bin.js"],
  ] as const) {
    writeFileSync(join(root, "packages", owner, "dist", binary), "// stub\n", "utf8");
  }
  return root;
}

test("exit removes all PatchMesh artifacts after init", () => {
  const root = monorepoCheckout();
  try {
    initializeRepository({ worktreeRoot: root, packageRoot: root, host: "opencode" });
    assert.equal(existsSync(join(root, ".patchmesh")), false, "precondition: .patchmesh not created by init");
    assert.equal(existsSync(join(root, ".claude", "settings.local.json")), true);
    assert.equal(existsSync(join(root, ".mcp.json")), true);
    assert.equal(existsSync(join(root, ".opencode", "plugins", "patchmesh.mjs")), true);
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /\.patchmesh\//);

    mkdirSync(join(root, ".patchmesh"), { recursive: true });
    writeFileSync(join(root, ".patchmesh", "ledger.db"), "", "utf8");

    const result = exitRepository({ worktreeRoot: root, yes: true });
    assert.equal(result.dryRun, false);

    assert.equal(existsSync(join(root, ".patchmesh")), false, ".patchmesh should be removed");
    assert.equal(existsSync(join(root, ".claude", "settings.local.json")), false, "settings should be removed when empty");
    assert.equal(existsSync(join(root, ".mcp.json")), false, ".mcp.json should be removed when empty");
    assert.equal(existsSync(join(root, ".opencode", "plugins", "patchmesh.mjs")), false, "plugin should be removed");
    // .gitignore may be removed entirely if it only contained the patchmesh entry
    if (existsSync(join(root, ".gitignore"))) {
      assert.ok(!readFileSync(join(root, ".gitignore"), "utf8").includes(".patchmesh"), "gitignore entry should be removed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit preserves other tools hooks", () => {
  const root = monorepoCheckout();
  try {
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: {
          PreToolUse: [
            { matcher: ".*", hooks: [{ type: "command", command: "othertool hook" }] },
          ],
        },
      }),
      "utf8",
    );
    initializeRepository({ worktreeRoot: root, packageRoot: root });

    exitRepository({ worktreeRoot: root, yes: true });

    assert.equal(existsSync(join(root, ".claude", "settings.local.json")), true);
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8")) as {
      permissions: unknown;
      hooks: Record<string, unknown>;
    };
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] }, "other tool permissions survive");
    assert.ok(settings.hooks["PreToolUse"], "other tool hooks survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit preserves other MCP servers", () => {
  const root = monorepoCheckout();
  try {
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          knowl: { type: "stdio", command: "knowl.cmd", args: ["serve"] },
          patchmesh: { type: "stdio", command: "node", args: ["packages/gateway/dist/bin.js"] },
        },
      }),
      "utf8",
    );

    exitRepository({ worktreeRoot: root, yes: true });

    assert.equal(existsSync(join(root, ".mcp.json")), true);
    const config = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    assert.ok(config.mcpServers["knowl"], "knowl server survives");
    assert.equal(config.mcpServers["patchmesh"], undefined, "patchmesh server is removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit dry run does not delete anything", () => {
  const root = monorepoCheckout();
  try {
    initializeRepository({ worktreeRoot: root, packageRoot: root });
    mkdirSync(join(root, ".patchmesh"), { recursive: true });
    writeFileSync(join(root, ".patchmesh", "ledger.db"), "", "utf8");

    const result = exitRepository({ worktreeRoot: root, yes: false });
    assert.equal(result.dryRun, true);

    assert.equal(existsSync(join(root, ".patchmesh")), true);
    assert.equal(existsSync(join(root, ".claude", "settings.local.json")), true);
    assert.equal(existsSync(join(root, ".mcp.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit on a repo that was never initialized", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-exit-clean-"));
  try {
    const result = exitRepository({ worktreeRoot: root, yes: true });
    const removedCount = result.steps.filter((step) => step.outcome === "removed").length;
    assert.equal(removedCount, 0, "nothing to remove on a clean repo");
    assert.match(renderExit(result, false), /Already clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit dry run renders correctly", () => {
  const root = monorepoCheckout();
  try {
    const text = renderExit(
      exitRepository({ worktreeRoot: root, yes: false }),
      false,
    );
    assert.match(text, /Dry run/);
    assert.match(text, /--yes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit JSON output is stable", () => {
  const root = monorepoCheckout();
  try {
    const json = renderExit(
      exitRepository({ worktreeRoot: root, yes: false }),
      true,
    );
    const parsed = JSON.parse(json) as { steps: unknown[]; dryRun: boolean };
    assert.equal(parsed.dryRun, true);
    assert.ok(Array.isArray(parsed.steps));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit requires --yes flag via CLI", async () => {
  const root = monorepoCheckout();
  try {
    mkdirSync(join(root, ".patchmesh"), { recursive: true });

    const result = await runCli(["exit"], { services, worktreeRoot: root });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /--yes/);
    assert.equal(existsSync(join(root, ".patchmesh")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit --yes via CLI removes everything", async () => {
  const root = monorepoCheckout();
  try {
    initializeRepository({ worktreeRoot: root, packageRoot: root });
    mkdirSync(join(root, ".patchmesh"), { recursive: true });
    writeFileSync(join(root, ".patchmesh", "ledger.db"), "", "utf8");

    const result = await runCli(["exit", "--yes"], { services, worktreeRoot: root });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /PatchMesh has been removed/);
    assert.equal(existsSync(join(root, ".patchmesh")), false);
    assert.equal(existsSync(join(root, ".claude", "settings.local.json")), false);
    assert.equal(existsSync(join(root, ".mcp.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit outside a git repo errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-exit-nogit-"));
  try {
    const result = await runCli(["exit", "--yes"], { services, worktreeRoot: null });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /exit must be run inside a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit is idempotent — running twice produces same result", () => {
  const root = monorepoCheckout();
  try {
    initializeRepository({ worktreeRoot: root, packageRoot: root });
    mkdirSync(join(root, ".patchmesh"), { recursive: true });

    exitRepository({ worktreeRoot: root, yes: true });
    const second = exitRepository({ worktreeRoot: root, yes: true });

    const removedCount = second.steps.filter((step) => step.outcome === "removed").length;
    assert.equal(removedCount, 0, "second run removes nothing");
    assert.match(renderExit(second, false), /Already clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
