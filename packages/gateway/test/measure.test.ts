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
    recordAnswer(path, { tool: "patchmesh_recap", answerBytes: 512, items: 3, withheld: 7 }, "2026-08-22T12:00:00.000Z");
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    assert.equal(line.v, 1);
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
    recordAnswer(path, { tool: "patchmesh_recent_activity", path: "src/a.ts", answerBytes: 100, items: 1, withheld: 0 });
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
        answerBytes: 1,
        items: 0,
        withheld: 0,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
