import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measurementPathFor, recordAnswer } from "../src/index.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "patchmesh-measure-"));
}

test("the hook's own injections are labelled, and carry who and what fired them", () => {
  const root = scratch();
  try {
    const path = measurementPathFor(root, ".patchmesh");
    recordAnswer(
      path,
      {
        tool: "session_start_recap",
        source: "session_start",
        ok: true,
        agentId: "agent_abc",
        trigger: "compact",
        answerBytes: 1_491,
        items: 5,
        withheld: 43,
      },
      "2026-08-22T12:00:00.000Z",
    );
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    // Bumped when `source`, `ok`, `agentId` and `trigger` were added: a reader counting
    // adoption has to be able to tell a v1 row -- which cannot say who or what asked -- from a
    // v2 row that can.
    assert.equal(line.v, 2);
    assert.equal(line.source, "session_start");
    assert.equal(line.tool, "session_start_recap");
    assert.equal(line.agentId, "agent_abc");
    assert.equal(line.trigger, "compact");
    // Both halves matter: cost alone cannot distinguish a compact answer from an absent one.
    assert.equal(line.items, 5);
    assert.equal(line.withheld, 43);
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
        tool: "session_start_recap",
        source: "session_start",
        answerBytes: 1,
        items: 0,
        withheld: 0,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a push that produced nothing is recorded too, so the ledger and this file can agree", () => {
  const root = scratch();
  try {
    const path = measurementPathFor(root, ".patchmesh");
    recordAnswer(path, {
      tool: "session_start_recap",
      source: "session_start",
      ok: false,
      answerBytes: 42,
      items: 0,
      withheld: 0,
    });
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    assert.equal(line.ok, false);
    assert.equal(line.items, 0);
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
    // A benchmark that exercises the hook path must not be able to write itself into the
    // record it is measuring.
    recordAnswer(path, {
      tool: "session_start_recap",
      source: "session_start",
      answerBytes: 1,
      items: 0,
      withheld: 0,
    });
    assert.throws(() => readFileSync(path, "utf8"));
  } finally {
    if (previous === undefined) delete process.env["PATCHMESH_MEASURE"];
    else process.env["PATCHMESH_MEASURE"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
