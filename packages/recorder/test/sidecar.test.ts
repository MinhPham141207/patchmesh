import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  writePendingAdvisory,
  readAndDeletePendingAdvisory,
  cleanupPendingAdvisories,
  type PendingAdvisory,
} from "../src/sidecar.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "patchmesh-sidecar-"));
}

const SAMPLE: PendingAdvisory = {
  path: "src/auth.ts",
  agentId: "agent_abc",
  hostToolName: "Edit",
  runningForMs: 45000,
  detectedAt: "2026-08-31T12:00:00.000Z",
};

test("write creates a sidecar file, read returns it, file is deleted", () => {
  const dir = tmpDir();
  try {
    writePendingAdvisory(dir, "call_123", SAMPLE);
    const result = readAndDeletePendingAdvisory(dir, "call_123");
    assert.deepEqual(result, SAMPLE);
    assert.equal(readAndDeletePendingAdvisory(dir, "call_123"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read returns null for missing sidecar", () => {
  const dir = tmpDir();
  try {
    assert.equal(readAndDeletePendingAdvisory(dir, "nonexistent"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup removes all sidecars", () => {
  const dir = tmpDir();
  try {
    writePendingAdvisory(dir, "call_a", SAMPLE);
    writePendingAdvisory(dir, "call_b", SAMPLE);
    cleanupPendingAdvisories(dir);
    assert.equal(readAndDeletePendingAdvisory(dir, "call_a"), null);
    assert.equal(readAndDeletePendingAdvisory(dir, "call_b"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup on missing directory does not throw", () => {
  assert.doesNotThrow(() => cleanupPendingAdvisories("/nonexistent/path"));
});