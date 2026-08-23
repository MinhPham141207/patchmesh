import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadServices } from "patchmesh-query";
import type { RecapOptions, RecapResult } from "patchmesh-query";
import { parseArgs } from "../src/args.js";
import { runCli } from "../src/main.js";

/**
 * `recap` reads the ledger itself rather than going through `ReadServices`, exactly as
 * `overlaps` does, so nothing here needs a real store.
 */
const services = new Proxy({} as ReadServices, {
  get: () => () => {
    throw new Error("recap must not go through the work-graph read services");
  },
});

const emptyRecap: RecapResult = { tasks: [], truncated: 0, unattributedCalls: 0 };

function capture(result: RecapResult = emptyRecap): {
  readonly read: (options: RecapOptions) => RecapResult;
  readonly calls: RecapOptions[];
} {
  const calls: RecapOptions[] = [];
  return {
    calls,
    read: (options) => {
      calls.push(options);
      return result;
    },
  };
}

test("recap answers from the ledger the repository owns", async () => {
  const recorded = capture({
    tasks: [{
      taskId: "task_a",
      agentIds: ["agent_a"],
      startedAt: "2026-08-23T01:00:00.000Z",
      endedAt: "2026-08-23T01:30:00.000Z",
      calls: 12,
      failed: 1,
      changedPaths: ["src/main.ts"],
      moreChanged: 0,
      commits: ["Bind observed changes to the calls that caused them"],
    }],
    truncated: 0,
    unattributedCalls: 0,
  });
  const result = await runCli(["recap", "--database", "/ledger.db"], {
    services,
    worktreeRoot: "/repo",
    readRecap: recorded.read,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /task_a/u);
  assert.match(result.stdout, /src\/main\.ts/u);
  // The commit label is the half that says what the work was for, so its absence would make
  // the command a call counter.
  assert.match(result.stdout, /committed: Bind observed changes/u);
  assert.equal(recorded.calls[0]?.worktreeRoot, "/repo");
  assert.equal(recorded.calls[0]?.ledgerPath, "/ledger.db");
});

test("recap passes its bounds through rather than quietly ignoring them", () => {
  const parsed = parseArgs(["recap", "--within", "90", "--limit", "3", "--agent", "agent_a"]);
  assert.equal(parsed.command, "recap");
  assert.equal(parsed.withinMinutes, 90);
  assert.equal(parsed.recapLimit, 3);
  assert.equal(parsed.agentFilters.agentId, "agent_a");
});

test("recap rejects bounds that cannot mean anything", () => {
  assert.throws(() => parseArgs(["recap", "--limit", "0"]), /positive whole number/u);
  assert.throws(() => parseArgs(["recap", "--within", "-5"]), /positive whole number/u);
});

test("recap is machine-readable on request", async () => {
  const recorded = capture();
  const result = await runCli(["recap", "--json", "--database", "/ledger.db"], {
    services,
    worktreeRoot: "/repo",
    readRecap: recorded.read,
  });
  assert.deepEqual(JSON.parse(result.stdout) as RecapResult, emptyRecap);
});

test("recap finds the repository it is standing in rather than requiring it", async () => {
  const recorded = capture();
  const result = await runCli(["recap", "--database", "/ledger.db"], {
    services,
    // No injected worktree. The repository is the unit of identity, so the command derives one
    // from the working directory -- which is what makes `patchmesh recap` work with no flags
    // from any subdirectory of a checkout.
    readRecap: recorded.read,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(recorded.calls.length, 1);
  assert.notEqual(recorded.calls[0]?.worktreeRoot, null);
});
