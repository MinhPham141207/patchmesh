import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  NodeObservationBoundary,
  type ObservationContext,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: directory, encoding: "utf8" });
  return result.stdout.trim();
}

function context(workspaceRoot: string, suffix: string): ObservationContext {
  return {
    workspaceRoot,
    repositoryId: "repo_11111111111111111111111111111111",
    workspaceId: `ws_${suffix}`,
    worktreeId: `wt_${suffix}`,
  };
}

async function createRepository(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m4-observation-"));
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.email", "patchmesh-tests@example.invalid");
  await git(directory, "config", "user.name", "PatchMesh Tests");
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "src", "example.txt"), "before\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

test("captures Git identity and changing file content", async () => {
  const directory = await createRepository();
  try {
    const boundary = new NodeObservationBoundary({
      source: {
        kind: "watcher",
        sourceId: "source_observation",
        instanceId: "11111111-1111-4111-8111-111111111111",
      },
    });
    const before = await boundary.captureBefore(context(directory, "22222222222222222222222222222222"));
    const beforeFile = before.snapshot.files.get("src/example.txt");
    assert.ok(before.snapshot.repository.commonDirectory);
    assert.ok(before.snapshot.repository.revision);
    assert.ok(before.snapshot.worktree.administrativeDirectory);
    assert.match(beforeFile?.gitBlob ?? "", /^[0-9a-f]{40}$/);
    assert.equal(
      beforeFile?.contentHash,
      createHash("sha256").update("before\n").digest("hex"),
    );

    writeFileSync(join(directory, "src", "example.txt"), "after\n");
    writeFileSync(join(directory, "untracked.txt"), "new\n");
    const after = await boundary.captureAfter(context(directory, "22222222222222222222222222222222"));

    assert.notEqual(after.snapshot.files.get("src/example.txt")?.contentHash, beforeFile?.contentHash);
    assert.equal(readFileSync(join(directory, "untracked.txt"), "utf8"), "new\n");
    assert.ok(after.snapshot.files.has("untracked.txt"));
    assert.deepEqual(after.outOfBandChanges, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shares Git common directory while keeping linked worktree administrative directories distinct", async () => {
  const directory = await createRepository();
  const linkedDirectory = join(directory, "linked");
  try {
    await git(directory, "worktree", "add", linkedDirectory, "-b", "linked");
    const boundary = new NodeObservationBoundary({
      source: {
        kind: "watcher",
        sourceId: "source_observation",
        instanceId: "22222222-2222-4222-8222-222222222222",
      },
    });
    const mainCapture = await boundary.captureBefore(context(directory, "33333333333333333333333333333333"));
    const linkedCapture = await boundary.captureBefore(context(linkedDirectory, "44444444444444444444444444444444"));

    assert.equal(mainCapture.snapshot.repository.commonDirectory, linkedCapture.snapshot.repository.commonDirectory);
    assert.notEqual(
      mainCapture.snapshot.worktree.administrativeDirectory,
      linkedCapture.snapshot.worktree.administrativeDirectory,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports degraded coverage when the workspace is not a Git worktree", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m4-non-git-"));
  try {
    writeFileSync(join(directory, "file.txt"), "content\n");
    const boundary = new NodeObservationBoundary({
      source: {
        kind: "watcher",
        sourceId: "source_observation",
        instanceId: "33333333-3333-4333-8333-333333333333",
      },
    });
    const capture = await boundary.captureBefore(context(directory, "55555555555555555555555555555555"));
    assert.equal(capture.snapshot.repository.commonDirectory, null);
    assert.equal(capture.snapshot.repository.revision, null);
    assert.ok(capture.gaps.some((gap) => gap.kind === "unverified"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
