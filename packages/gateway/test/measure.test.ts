import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measurementPathFor, recordAnswer } from "../src/index.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "patchmesh-measure-"));
}

test("an answer's cost and payload are both recorded, so an empty answer is not read as cheap", () => {
  const root = scratch();
  try {
    const path = measurementPathFor(root, ".patchmesh");
    recordAnswer(path, { tool: "patchmesh_recap", source: "mcp", answerBytes: 512, items: 3, withheld: 7 }, "2026-08-22T12:00:00.000Z");
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    // Bumped when `source`, `ok`, `agentId` and `trigger` were added: a reader counting adoption
    // has to be able to tell a row that can name its caller from one that cannot.
    assert.equal(line.v, 2);
    assert.equal(line.source, "mcp");
    assert.equal(line.tool, "patchmesh_recap");
    assert.equal(line.answerBytes, 512);
    // Both halves matter: cost alone cannot distinguish a compact answer from an absent one.
    assert.equal(line.items, 3);
    assert.equal(line.withheld, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the requested path is kept, because displacement is only testable against it", () => {
  const root = scratch();
  try {
    const path = measurementPathFor(root, ".patchmesh");
    recordAnswer(path, { tool: "patchmesh_recent_activity", source: "mcp", path: "src/a.ts", answerBytes: 100, items: 1, withheld: 0 });
    // Whether the caller read the file anyway is a join between this line and later calls.
    assert.equal(JSON.parse(readFileSync(path, "utf8").trim()).path, "src/a.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recording never throws, whatever the filesystem does", () => {
  const root = scratch();
  try {
    // A file where the directory must go: every write below is impossible.
    writeFileSync(join(root, ".patchmesh"), "not a directory", "utf8");
    assert.doesNotThrow(() =>
      recordAnswer(measurementPathFor(root, ".patchmesh"), {
        tool: "patchmesh_recap",
        source: "mcp",
        answerBytes: 1,
        items: 0,
        withheld: 0,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed call is recorded too, so the ledger and this file can agree", () => {
  const root = scratch();
  try {
    const path = measurementPathFor(root, ".patchmesh");
    // Only the success path used to write anything, and the tools fail soft -- so a call that
    // errored left no trace at all. Counted against the ledger the two disagreed in both
    // directions: 7 recalls requested against 4 logged, 4 recaps requested against 5 logged.
    recordAnswer(path, { tool: "patchmesh_recap", source: "mcp", ok: false, answerBytes: 42, items: 0, withheld: 0 });
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    assert.equal(line.ok, false);
    assert.equal(line.items, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hook's own injections are labelled, and carry who and what fired them", () => {
  const root = scratch();
  try {
    const path = measurementPathFor(root, ".patchmesh");
    recordAnswer(path, {
      tool: "session_start_recap",
      source: "session_start",
      agentId: "agent_abc",
      trigger: "compact",
      answerBytes: 1_491,
      items: 5,
      withheld: 43,
    });
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    // An injection nobody asked for and a call an agent chose to make are different events.
    // Counting them together is how 88 answers were read as adoption when 77 were the hook.
    assert.equal(line.source, "session_start");
    assert.equal(line.agentId, "agent_abc");
    assert.equal(line.trigger, "compact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PATCHMESH_MEASURE=0 stops measurement writing to the file it measures", () => {
  const root = scratch();
  const previous = process.env["PATCHMESH_MEASURE"];
  try {
    process.env["PATCHMESH_MEASURE"] = "0";
    const path = measurementPathFor(root, ".patchmesh");
    // A local latency probe wrote 25 rows that were indistinguishable from adoption. Measuring
    // a system should not be a way of changing its numbers.
    recordAnswer(path, { tool: "patchmesh_recap", source: "probe", answerBytes: 1, items: 0, withheld: 0 });
    assert.throws(() => readFileSync(path, "utf8"));
  } finally {
    if (previous === undefined) delete process.env["PATCHMESH_MEASURE"];
    else process.env["PATCHMESH_MEASURE"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
