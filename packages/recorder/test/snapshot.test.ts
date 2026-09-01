import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffSnapshots, takeSnapshot } from "../src/snapshot.js";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-snapshot-"));
  execSync("git init", { cwd: root, stdio: "pipe" });
  execSync("git config user.email \"test@test.com\"", { cwd: root, stdio: "pipe" });
  execSync("git config user.name \"Test\"", { cwd: root, stdio: "pipe" });
  return root;
}

function commit(repo: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const fullPath = join(repo, rel);
    const dir = join(repo, rel, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
  execSync("git add -A", { cwd: repo, stdio: "pipe" });
  execSync("git commit -m \"update\"", { cwd: repo, stdio: "pipe" });
}

test("takeSnapshot returns empty for empty repo", () => {
  const repo = gitRepo();
  try {
    const snap = takeSnapshot(repo);
    assert.equal(snap.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("takeSnapshot hashes tracked files", () => {
  const repo = gitRepo();
  try {
    commit(repo, { "a.txt": "hello", "b.txt": "world" });
    const snap = takeSnapshot(repo);
    assert.equal(snap.length, 2);
    assert.ok(snap.some((s) => s.path === "a.txt"));
    assert.ok(snap.some((s) => s.path === "b.txt"));
    for (const s of snap) {
      assert.equal(typeof s.hash, "string");
      assert.equal(s.hash.length, 32);
      assert.ok(s.size > 0);
      assert.ok(typeof s.mtime === "string");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("diffSnapshots detects added files", () => {
  const repo = gitRepo();
  try {
    commit(repo, { "a.txt": "a" });
    const before = takeSnapshot(repo);
    commit(repo, { "b.txt": "b" });
    const after = takeSnapshot(repo);
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.added, ["b.txt"]);
    assert.deepEqual(diff.modified, []);
    assert.deepEqual(diff.deleted, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("diffSnapshots detects modified files", () => {
  const repo = gitRepo();
  try {
    commit(repo, { "a.txt": "v1" });
    const before = takeSnapshot(repo);
    writeFileSync(join(repo, "a.txt"), "v2", "utf8");
    execSync("git add a.txt", { cwd: repo, stdio: "pipe" });
    execSync("git commit -m \"change\"", { cwd: repo, stdio: "pipe" });
    const after = takeSnapshot(repo);
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.modified, ["a.txt"]);
    assert.deepEqual(diff.deleted, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("diffSnapshots detects deleted files", () => {
  const repo = gitRepo();
  try {
    commit(repo, { "a.txt": "a", "b.txt": "b" });
    const before = takeSnapshot(repo);
    execSync("git rm b.txt", { cwd: repo, stdio: "pipe" });
    execSync("git commit -m \"delete\"", { cwd: repo, stdio: "pipe" });
    const after = takeSnapshot(repo);
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.modified, []);
    assert.deepEqual(diff.deleted, ["b.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("diffSnapshots with no changes returns empty", () => {
  const repo = gitRepo();
  try {
    commit(repo, { "a.txt": "a" });
    const before = takeSnapshot(repo);
    const after = takeSnapshot(repo);
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.modified, []);
    assert.deepEqual(diff.deleted, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("takeSnapshot handles binary files", () => {
  const repo = gitRepo();
  try {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    writeFileSync(join(repo, "data.bin"), binary);
    execSync("git add data.bin", { cwd: repo, stdio: "pipe" });
    execSync("git commit -m \"binary\"", { cwd: repo, stdio: "pipe" });
    const snap = takeSnapshot(repo);
    assert.equal(snap.length, 1);
    assert.equal(snap[0]!.path, "data.bin");
    assert.equal(snap[0]!.size, 5);
    assert.equal(snap[0]!.hash.length, 32);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("takeSnapshot handles nested directories", () => {
  const repo = gitRepo();
  try {
    commit(repo, { "src/deep/nested/file.ts": "content" });
    const snap = takeSnapshot(repo);
    assert.equal(snap.length, 1);
    assert.equal(snap[0]!.path, "src/deep/nested/file.ts");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("takeSnapshot skips missing tracked files gracefully", () => {
  const repo = gitRepo();
  try {
    commit(repo, { "a.txt": "a" });
    execSync("git rm --cached a.txt", { cwd: repo, stdio: "pipe" });
    writeFileSync(join(repo, "a.txt"), "still exists", "utf8");
    execSync("git add a.txt", { cwd: repo, stdio: "pipe" });
    execSync("git commit -m \"re-add\"", { cwd: repo, stdio: "pipe" });
    rmSync(join(repo, "a.txt"));
    const snap = takeSnapshot(repo);
    assert.equal(snap.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("performance: snapshot 100+ files in under 500ms", () => {
  const repo = gitRepo();
  try {
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++) {
      files[`dir/file-${i}.ts`] = `// file ${i}\n${"x".repeat(100)}`;
    }
    commit(repo, files);

    const start = performance.now();
    const snap = takeSnapshot(repo);
    const elapsed = performance.now() - start;

    assert.equal(snap.length, 120);
    assert.ok(elapsed < 500, `snapshot took ${elapsed.toFixed(1)}ms, expected <500ms`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("diffSnapshots handles mixed add/modify/delete", () => {
  const repo = gitRepo();
  try {
    commit(repo, { "a.txt": "v1", "b.txt": "keep" });
    const before = takeSnapshot(repo);

    writeFileSync(join(repo, "a.txt"), "v2", "utf8");
    execSync("git rm b.txt", { cwd: repo, stdio: "pipe" });
    commit(repo, { "c.txt": "new" });

    const after = takeSnapshot(repo);
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.added, ["c.txt"]);
    assert.deepEqual(diff.modified, ["a.txt"]);
    assert.deepEqual(diff.deleted, ["b.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
