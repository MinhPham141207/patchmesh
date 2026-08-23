import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import {
  NodeObservationBoundary,
  OBSERVATION_IGNORE_POLICY_VERSION,
  diffSnapshots,
  isIgnoredObservationPath,
  type ObservationContext,
} from "../src/index.js";

/**
 * Give the OS watcher time to deliver what was just written.
 *
 * There is no observable signal to poll here — the journal these tests are about is internal
 * to the boundary, and the only public way to read it is to open a window, which is the thing
 * under test. So this is a wait, and the only honest question is how long.
 *
 * It was 50ms, which is a number that holds on an idle developer machine and nowhere else.
 * `fs.watch` delivery is not bounded by anything: on a loaded CI runner, with a virtualised
 * disk and a virus scanner in the path, it can take an order of magnitude longer. A test that
 * assumes otherwise passes locally forever and fails on someone else's machine — the same
 * shape as the platform-pinned assertions that kept this repository's CI red on Linux from the
 * day it was added.
 *
 * The cost of being generous is bounded and small: this runs three times in the whole suite.
 * The cost of being wrong is a red build that reproduces nowhere.
 */
const WATCHER_SETTLE_MS = 750;
const settleWatcher = () => new Promise<void>((resolve) => setTimeout(resolve, WATCHER_SETTLE_MS));

function reconciliationHarness() {
  const pending: Array<() => Promise<void>> = [];
  return {
    scheduler(work: () => Promise<void>) { pending.push(work); },
    async runNext() {
      const work = pending.shift();
      assert.ok(work, "expected a scheduled reconciliation");
      await work();
    },
  };
}

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
  writeFileSync(join(directory, "src", "second.txt"), "second\n");
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
    assert.equal(before.gaps.some((gap) => gap.scope === "tool.effects"), false);
    assert.match(beforeFile?.gitBlob ?? "", /^[0-9a-f]{40}$/);
    assert.match(before.snapshot.files.get("src/second.txt")?.gitBlob ?? "", /^[0-9a-f]{40}$/);
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
    assert.equal(
      after.gaps.some((gap) =>
        gap.kind === "unverified" &&
        gap.scope === "tool.effects" &&
        gap.reason.includes("cannot prove each effect originated"),
      ),
      true,
    );
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

/**
 * A second, non-canonical spelling of one directory.
 *
 * Each platform gets a different one, because the platforms differ in precisely the way that
 * causes the bug this guards: Windows is case-insensitive, so re-casing the path names the same
 * directory, while POSIX is case-sensitive and needs a symlink instead. Neither needs elevated
 * privileges, unlike the 8.3 short path that first exposed this on a CI runner - that depends
 * on a volume feature which can be switched off, so it is not something a test may rely on.
 */
function alternateSpelling(directory: string, scratch: string): string {
  if (process.platform === "win32") return directory.toUpperCase();
  const link = join(scratch, "root");
  symlinkSync(directory, link, "dir");
  return link;
}

test("one repository keeps one common directory across spellings of its root", async () => {
  const directory = await createRepository();
  const scratch = mkdtempSync(join(tmpdir(), "patchmesh-m4-spelling-"));
  try {
    await git(directory, "worktree", "add", join(directory, "linked"), "-b", "spelling");
    const alternate = alternateSpelling(directory, scratch);
    assert.notEqual(alternate, directory, "this test needs a genuinely different spelling to mean anything");

    const boundary = new NodeObservationBoundary({
      source: {
        kind: "watcher",
        sourceId: "source_observation",
        instanceId: "55555555-5555-4555-8555-555555555555",
      },
    });
    const viaAlternate = await boundary.captureBefore(context(alternate, "55555555555555555555555555555555"));
    const viaLinked = await boundary.captureBefore(
      context(join(directory, "linked"), "66666666666666666666666666666666"),
    );

    // The regression, found by the first windows-latest CI run: `git rev-parse
    // --git-common-dir` answers relatively from a primary worktree and absolutely - already
    // resolved by git - from a linked one. Without canonicalization the two disagree whenever
    // the root is spelled non-canonically, and `commonDirectory` is the value that decides two
    // worktrees are one repository, so the identity signal contradicts itself.
    assert.equal(
      viaAlternate.snapshot.repository.commonDirectory,
      viaLinked.snapshot.repository.commonDirectory,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
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

test("window observation preserves create, modify, and delete effects equivalent to snapshots", async () => {
  const directory = await createRepository();
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "44444444-4444-4444-8444-444444444444" },
    watcherFactory: (_root, value) => { listener = value; return watcher; },
  });
  const observationContext = context(directory, "66666666666666666666666666666666");
  try {
    const window = await boundary.beginWindow(observationContext);
    writeFileSync(join(directory, "created.txt"), "created\n");
    writeFileSync(join(directory, "src", "example.txt"), "modified\n");
    rmSync(join(directory, "src", "second.txt"));
    listener?.("rename", "created.txt");
    listener?.("change", "src/example.txt");
    listener?.("rename", "src/second.txt");
    const result = await boundary.endWindow(window);
    const snapshotAfter = await boundary.captureAfter(observationContext);
    assert.equal(result.completeness, "complete", JSON.stringify(result.capture.gaps));
    assert.deepEqual(
      diffSnapshots(window.before.snapshot, result.capture.snapshot, false).changes.map((change) => [change.path, change.changeKind]),
      diffSnapshots(window.before.snapshot, snapshotAfter.snapshot, false).changes.map((change) => [change.path, change.changeKind]),
    );
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coarse directory events hash metadata candidates but remain explicitly degraded", async () => {
  const directory = await createRepository();
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let candidateReads = 0;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "19191919-1919-4919-8919-191919191919" },
    watcherFactory: (_root, value) => { listener = value; return watcher; },
    candidateReader: async (path) => { candidateReads += 1; return readFileSync(path); },
  });
  const observationContext = context(directory, "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
  try {
    const window = await boundary.beginWindow(observationContext);
    writeFileSync(join(directory, "src", "example.txt"), "directory candidate\n");
    listener?.("change", "src");
    const result = await boundary.endWindow(window);
    assert.equal(result.completeness, "degraded");
    assert.ok(result.capture.gaps.some((item) => item.scope === "src" && item.reason.includes("directory candidate")));
    assert.equal(candidateReads, 1);
    assert.notEqual(result.capture.snapshot.files.get("src/example.txt")?.contentHash, window.before.snapshot.files.get("src/example.txt")?.contentHash);
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mixed directory and child candidates scan the complete directory and remain degraded", async () => {
  const directory = await createRepository();
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let candidateReads = 0;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "20202020-2020-4020-8020-202020202020" },
    watcherFactory: (_root, value) => { listener = value; return watcher; },
    candidateReader: async (path) => { candidateReads += 1; return readFileSync(path); },
  });
  const observationContext = context(directory, "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2");
  try {
    const window = await boundary.beginWindow(observationContext);
    writeFileSync(join(directory, "src", "example.txt"), "reported child\n");
    writeFileSync(join(directory, "src", "second.txt"), "unreported child\n");
    listener?.("change", "src");
    listener?.("change", "src/example.txt");
    const result = await boundary.endWindow(window);
    assert.equal(result.completeness, "degraded");
    assert.ok(result.capture.gaps.some((item) => item.scope === "src" && item.reason.includes("directory candidate")));
    assert.equal(candidateReads, 2, "directory and exact child candidates must not hash the same child twice");
    assert.notEqual(result.capture.snapshot.files.get("src/example.txt")?.contentHash, window.before.snapshot.files.get("src/example.txt")?.contentHash);
    assert.notEqual(result.capture.snapshot.files.get("src/second.txt")?.contentHash, window.before.snapshot.files.get("src/second.txt")?.contentHash);
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watcher events raised during initialization are reconciled without loss or duplication", async () => {
  const directory = await createRepository();
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  let initialized = false;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "21212121-2121-4121-8121-212121212121" },
    watcherFactory: (_root, listener) => {
      writeFileSync(join(directory, "initialization-race.txt"), "created after watcher startup\n");
      listener("rename", "initialization-race.txt");
      initialized = true;
      return watcher;
    },
  });
  const observationContext = context(directory, "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3");
  try {
    const first = await boundary.beginWindow(observationContext);
    assert.equal(initialized, true);
    assert.equal(first.before.snapshot.files.has("initialization-race.txt"), true);
    assert.deepEqual(first.before.outOfBandChanges, []);
    await boundary.endWindow(first);
    const second = await boundary.beginWindow(observationContext);
    assert.deepEqual(second.before.outOfBandChanges, []);
    await boundary.endWindow(second);
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("incremental Git blob hashing is limited to exact changed candidates", async () => {
  const directory = await createRepository();
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "22222222-2222-4222-8222-222222222222" },
    watcherFactory: (_root, value) => { listener = value; return watcher; },
  });
  const observationContext = context(directory, "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4");
  try {
    const window = await boundary.beginWindow(observationContext);
    assert.equal(window.before.snapshot.files.get("src/example.txt")?.gitBlob, null);
    assert.equal(window.before.snapshot.files.get("src/second.txt")?.gitBlob, null);
    writeFileSync(join(directory, "src", "example.txt"), "candidate blob\n");
    listener?.("change", "src/example.txt");
    const result = await boundary.endWindow(window);
    assert.match(result.capture.snapshot.files.get("src/example.txt")?.gitBlob ?? "", /^[0-9a-f]{40,64}$/u);
    assert.equal(result.capture.snapshot.files.get("src/second.txt")?.gitBlob, null);
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("overlapping windows degrade instead of claiming deterministic attribution", async () => {
  const directory = await createRepository();
  const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "55555555-5555-4555-8555-555555555555" } });
  const observationContext = context(directory, "77777777777777777777777777777777");
  try {
    const first = await boundary.beginWindow(observationContext);
    const second = await boundary.beginWindow(observationContext);
    const result = await boundary.endWindow(second);
    assert.equal(result.completeness, "degraded");
    assert.ok(result.capture.gaps.some((gap) => gap.kind === "overlapping_window"));
    await boundary.endWindow(first);
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded watcher journals fail closed after queue loss", async () => {
  const directory = await createRepository();
  const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "66666666-6666-4666-8666-666666666666" }, maxJournalEntries: 1 });
  const observationContext = context(directory, "88888888888888888888888888888888");
  try {
    const window = await boundary.beginWindow(observationContext);
    writeFileSync(join(directory, "first.txt"), "first\n");
    await settleWatcher();
    writeFileSync(join(directory, "second.txt"), "second\n");
    await settleWatcher();
    const result = await boundary.endWindow(window);
    assert.equal(result.completeness, "degraded");
    assert.equal(result.reconciliationRequired, true);
    assert.ok(result.capture.gaps.some((gap) => gap.kind === "watcher_overflow"));
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("injectable watcher failures degrade the active window", async () => {
  const directory = await createRepository();
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "77777777-7777-4777-8777-777777777777" }, watcherFactory: () => watcher });
  const observationContext = context(directory, "99999999999999999999999999999999");
  try {
    const window = await boundary.beginWindow(observationContext);
    watcher.emit("error", new Error("injected watcher failure"));
    const result = await boundary.endWindow(window);
    assert.equal(result.completeness, "degraded");
    assert.ok(result.capture.gaps.some((gap) => gap.kind === "watcher_unavailable"));
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("changes between windows are emitted as out-of-band instead of attributed effects", async () => {
  const directory = await createRepository();
  const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "88888888-8888-4888-8888-888888888888" } });
  const observationContext = context(directory, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  try {
    const initial = await boundary.beginWindow(observationContext);
    await boundary.endWindow(initial);
    writeFileSync(join(directory, "between-windows.txt"), "outside\n");
    await settleWatcher();
    const next = await boundary.beginWindow(observationContext);
    assert.equal(next.before.snapshot.files.has("between-windows.txt"), true);
    assert.deepEqual(next.before.outOfBandChanges.map((change) => [change.path, change.outOfBand]), [["between-windows.txt", true]]);
    await boundary.endWindow(next);
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace-root replacement fails closed for a reused workspace session", async () => {
  const firstRoot = await createRepository();
  const secondRoot = await createRepository();
  const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "99999999-9999-4999-8999-999999999999" } });
  const firstContext = context(firstRoot, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  try {
    await boundary.beginWindow(firstContext);
    const replacement = await boundary.beginWindow({ ...firstContext, workspaceRoot: secondRoot });
    assert.ok(replacement.before.gaps.some((gap) => gap.kind === "root_replaced"));
  } finally {
    await boundary.dispose();
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("on-disk linked-worktree Git identity replacement fails closed without mixing revision metadata", async () => {
  const directory = await createRepository();
  const linkedA = `${directory}-linked-a`;
  const linkedB = `${directory}-linked-b`;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "23232323-2323-4323-8323-232323232323" },
    watcherFactory: () => watcher,
    reconciliationEveryWindows: 100,
  });
  try {
    await git(directory, "worktree", "add", "--detach", linkedA, "HEAD");
    await git(directory, "worktree", "add", "--detach", linkedB, "HEAD");
    const observationContext = context(linkedA, "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4");
    const window = await boundary.beginWindow(observationContext);
    const originalRevision = window.before.snapshot.repository.revision;

    writeFileSync(join(linkedB, "src", "example.txt"), "replacement worktree revision\n");
    await git(linkedB, "add", "src/example.txt");
    await git(linkedB, "commit", "-m", "replacement identity revision");
    assert.notEqual(await git(linkedB, "rev-parse", "HEAD"), originalRevision);
    renameSync(join(linkedA, ".git"), join(linkedA, ".git.previous"));
    writeFileSync(join(linkedA, ".git"), readFileSync(join(linkedB, ".git")));

    const result = await boundary.endWindow(window);
    assert.equal(result.completeness, "degraded");
    assert.equal(result.capture.snapshot.repository.revision, originalRevision);
    assert.ok(result.capture.gaps.some((item) => item.kind === "root_replaced"));
  } finally {
    await boundary.dispose();
    rmSync(linkedA, { recursive: true, force: true });
    rmSync(linkedB, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Git identity replacement during candidate hashing is post-checked and fails closed", async () => {
  const directory = await createRepository();
  const linkedA = `${directory}-race-linked-a`;
  const linkedB = `${directory}-race-linked-b`;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let replaceDuringRead = false;
  let replaced = false;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "24242424-2424-4424-8424-242424242424" },
    watcherFactory: (_root, value) => { listener = value; return watcher; },
    reconciliationEveryWindows: 100,
    candidateReader: async (path) => {
      const content = readFileSync(path);
      if (replaceDuringRead) {
        replaceDuringRead = false;
        renameSync(join(linkedA, ".git"), join(linkedA, ".git.race-previous"));
        writeFileSync(join(linkedA, ".git"), readFileSync(join(linkedB, ".git")));
        replaced = true;
      }
      return content;
    },
  });
  try {
    await git(directory, "worktree", "add", "--detach", linkedA, "HEAD");
    await git(directory, "worktree", "add", "--detach", linkedB, "HEAD");
    const observationContext = context(linkedA, "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
    const window = await boundary.beginWindow(observationContext);
    const originalRevision = window.before.snapshot.repository.revision;

    writeFileSync(join(linkedB, "src", "example.txt"), "race replacement revision\n");
    await git(linkedB, "add", "src/example.txt");
    await git(linkedB, "commit", "-m", "race replacement identity revision");
    assert.notEqual(await git(linkedB, "rev-parse", "HEAD"), originalRevision);
    writeFileSync(join(linkedA, "src", "example.txt"), "candidate triggers replacement\n");
    replaceDuringRead = true;
    listener!("change", "src/example.txt");

    const result = await boundary.endWindow(window);
    assert.equal(replaced, true);
    assert.equal(result.completeness, "degraded");
    assert.equal(result.capture.snapshot.repository.revision, originalRevision);
    assert.equal(result.capture.snapshot.files.get("src/example.txt")?.gitBlob, null);
    assert.ok(result.capture.gaps.some((item) => item.kind === "root_replaced"));
  } finally {
    await boundary.dispose();
    rmSync(linkedA, { recursive: true, force: true });
    rmSync(linkedB, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unreadable watcher candidates degrade coverage deterministically", async () => {
  const directory = await createRepository();
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    watcherFactory: (_root, value) => { listener = value; return watcher; },
    candidateReader: async () => { throw Object.assign(new Error("injected unreadable candidate"), { code: "EACCES" }); },
  });
  const observationContext = context(directory, "cccccccccccccccccccccccccccccccc");
  try {
    const window = await boundary.beginWindow(observationContext);
    listener?.("change", "src/example.txt");
    const result = await boundary.endWindow(window);
    assert.equal(result.completeness, "degraded");
    assert.equal(result.reconciliationRequired, true);
    assert.ok(result.capture.gaps.some((gap) => gap.kind === "unverified" && gap.reason.includes("could not be read")));
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared versioned ignore policy is equivalent for full and incremental observation", async () => {
  const directory = await createRepository();
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    watcherFactory: (_root, value) => { listener = value; return watcher; },
  });
  const observationContext = context(directory, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  try {
    assert.equal(OBSERVATION_IGNORE_POLICY_VERSION, "phase2-observation-ignore-v1");
    assert.equal(isIgnoredObservationPath(".git/HEAD"), true);
    assert.equal(isIgnoredObservationPath(".evidence/runtime/trace.json"), true);
    assert.equal(isIgnoredObservationPath("vendor/node_modules/package/index.js"), true);
    assert.equal(isIgnoredObservationPath("src/example.txt"), false);
    const window = await boundary.beginWindow(observationContext);
    listener?.("change", ".git/HEAD");
    listener?.("change", ".evidence/runtime/trace.json");
    const result = await boundary.endWindow(window);
    const full = await boundary.captureAfter(observationContext);
    assert.equal(result.completeness, "complete");
    assert.equal(result.capture.snapshot.files.has(".git/HEAD"), false);
    assert.equal(result.capture.snapshot.files.has(".evidence/runtime/trace.json"), false);
    const logicalFiles = (files: ReadonlyMap<string, { readonly contentHash: string; readonly fileKind: string }>) => [...files].map(([path, state]) => [path, state.contentHash, state.fileKind]);
    assert.deepEqual(logicalFiles(result.capture.snapshot.files), logicalFiles(full.snapshot.files));
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("processed watcher entries are pruned instead of causing lifetime overflow", async () => {
  const directory = await createRepository();
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    maxJournalEntries: 1,
    watcherFactory: (_root, value) => { listener = value; return watcher; },
  });
  const observationContext = context(directory, "ffffffffffffffffffffffffffffffff");
  try {
    for (let index = 0; index < 3; index += 1) {
      const window = await boundary.beginWindow(observationContext);
      const path = `candidate-${index}.txt`;
      writeFileSync(join(directory, path), `${index}\n`);
      listener?.("change", path);
      const result = await boundary.endWindow(window);
      assert.equal(result.completeness, "complete");
      assert.equal(result.capture.gaps.some((item) => item.kind === "watcher_overflow"), false);
    }
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("overflow remains degraded for reconciliation and recovers only on a later clean window", async () => {
  const directory = await createRepository();
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const reconciliation = reconciliationHarness();
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
    maxJournalEntries: 1,
    reconciliationEveryWindows: 1,
    reconciliationScheduler: reconciliation.scheduler,
    watcherFactory: (_root, value) => { listener = value; return watcher; },
  });
  const observationContext = context(directory, "10101010101010101010101010101010");
  try {
    const overflowWindow = await boundary.beginWindow(observationContext);
    writeFileSync(join(directory, "lost.txt"), "lost\n");
    listener?.("change", "lost.txt");
    writeFileSync(join(directory, "retained.txt"), "retained\n");
    listener?.("change", "retained.txt");
    const overflow = await boundary.endWindow(overflowWindow);
    assert.equal(overflow.completeness, "degraded");
    assert.ok(overflow.capture.gaps.some((item) => item.kind === "watcher_overflow"));
    await reconciliation.runNext();

    const reconciliationWindow = await boundary.beginWindow(observationContext);
    const reconciliationResult = await boundary.endWindow(reconciliationWindow);
    assert.equal(reconciliationResult.completeness, "degraded");
    assert.ok(reconciliationResult.capture.gaps.some((item) => item.kind === "watcher_overflow"));
    assert.ok(reconciliationResult.capture.gaps.some((item) => item.kind === "reconciliation_mismatch"));
    await reconciliation.runNext();

    const recoveredWindow = await boundary.beginWindow(observationContext);
    assert.equal(recoveredWindow.before.gaps.some((item) => item.kind === "watcher_overflow"), false);
    const recovered = await boundary.endWindow(recoveredWindow);
    assert.equal(recovered.completeness, "complete");
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("disposed and ABA-stale windows fail closed without rescanning another root", async () => {
  const directory = await createRepository();
  const observationContext = context(directory, "20202020202020202020202020202020");
  const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } });
  try {
    const stale = await boundary.beginWindow(observationContext);
    await boundary.dispose(observationContext.workspaceId);
    const replacement = await boundary.beginWindow(observationContext);
    const staleResult = await boundary.endWindow(stale);
    assert.equal(staleResult.completeness, "degraded");
    assert.strictEqual(staleResult.capture.snapshot, stale.before.snapshot);
    assert.ok(staleResult.capture.gaps.some((item) => item.kind === "overlapping_window"));
    const replacementResult = await boundary.endWindow(replacement);
    assert.equal(replacementResult.completeness, "complete");
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("window finalization retains exclusivity and rejects a concurrent begin", async () => {
  const directory = await createRepository();
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "13131313-1313-4313-8313-131313131313" },
    quiescenceMs: 50,
    watcherFactory: () => watcher,
  });
  const observationContext = context(directory, "40404040404040404040404040404040");
  try {
    const first = await boundary.beginWindow(observationContext);
    const finalizing = boundary.endWindow(first);
    const overlapping = await boundary.beginWindow(observationContext);
    assert.ok(overlapping.before.gaps.some((item) => item.kind === "overlapping_window"));
    const rejected = await boundary.endWindow(overlapping);
    assert.equal(rejected.completeness, "degraded");
    const firstResult = await finalizing;
    assert.equal(firstResult.completeness, "degraded");
    assert.ok(firstResult.capture.gaps.some((item) => item.kind === "overlapping_window"));
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("disposal during finalization makes the active window stale", async () => {
  const directory = await createRepository();
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "14141414-1414-4414-8414-141414141414" },
    quiescenceMs: 50,
  });
  const observationContext = context(directory, "50505050505050505050505050505050");
  try {
    const window = await boundary.beginWindow(observationContext);
    const finalizing = boundary.endWindow(window);
    await boundary.dispose(observationContext.workspaceId);
    const result = await finalizing;
    assert.equal(result.completeness, "degraded");
    assert.strictEqual(result.capture.snapshot, window.before.snapshot);
    assert.ok(result.capture.gaps.some((item) => item.kind === "overlapping_window"));
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("events arriving during candidate hashing remain queued and become out-of-band", async () => {
  const directory = await createRepository();
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  let releaseRead!: () => void;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  let firstCandidate = true;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_observation", instanceId: "15151515-1515-4515-8515-151515151515" },
    quiescenceMs: 0,
    watcherFactory: (_root, value) => { listener = value; return watcher; },
    candidateReader: async (path) => {
      const bytes = readFileSync(path);
      if (firstCandidate) {
        firstCandidate = false;
        markReadStarted();
        await readReleased;
      }
      return bytes;
    },
  });
  const observationContext = context(directory, "60606060606060606060606060606060");
  try {
    const window = await boundary.beginWindow(observationContext);
    writeFileSync(join(directory, "during-first.txt"), "first\n");
    listener?.("change", "during-first.txt");
    const finalizing = boundary.endWindow(window);
    await readStarted;
    writeFileSync(join(directory, "during-second.txt"), "second\n");
    listener?.("change", "during-second.txt");
    releaseRead();
    const result = await finalizing;
    assert.equal(result.completeness, "degraded");
    assert.ok(result.capture.gaps.some((item) => item.kind === "unattributed"));
    const next = await boundary.beginWindow(observationContext);
    assert.ok(next.before.outOfBandChanges.some((change) => change.path === "during-second.txt" && change.outOfBand));
    await boundary.endWindow(next);
  } finally {
    releaseRead();
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initial scan gaps remain attached to the incremental window", async (testContext) => {
  const directory = await createRepository();
  const outside = mkdtempSync(join(tmpdir(), "patchmesh-observation-initial-gap-"));
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  try {
    try {
      symlinkSync(outside, join(directory, "initial-unsafe-link"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        testContext.skip("symbolic links require an unavailable Windows privilege");
        return;
      }
      throw error;
    }
    const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "16161616-1616-4616-8616-161616161616" }, watcherFactory: () => watcher });
    const window = await boundary.beginWindow(context(directory, "70707070707070707070707070707070"));
    assert.ok(window.before.gaps.some((item) => item.scope === "initial-unsafe-link" && item.reason.includes("escapes")));
    const result = await boundary.endWindow(window);
    assert.equal(result.completeness, "degraded");
    const stillIncomplete = await boundary.beginWindow(context(directory, "70707070707070707070707070707070"));
    assert.ok(stillIncomplete.before.gaps.some((item) => item.scope === "initial-unsafe-link" && item.reason.includes("escapes")));
    assert.equal((await boundary.endWindow(stillIncomplete)).completeness, "degraded");
    await boundary.dispose();
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("incremental candidates cannot follow an ancestor symlink outside the workspace", async (testContext) => {
  const directory = await createRepository();
  const outside = mkdtempSync(join(tmpdir(), "patchmesh-observation-ancestor-link-"));
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "17171717-1717-4717-8717-171717171717" }, watcherFactory: (_root, value) => { listener = value; return watcher; } });
  const observationContext = context(directory, "80808080808080808080808080808080");
  try {
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    const window = await boundary.beginWindow(observationContext);
    try {
      symlinkSync(outside, join(directory, "unsafe-ancestor"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        testContext.skip("symbolic links require an unavailable Windows privilege");
        return;
      }
      throw error;
    }
    listener?.("change", "unsafe-ancestor/secret.txt");
    const result = await boundary.endWindow(window);
    assert.equal(result.completeness, "degraded");
    assert.equal(result.capture.snapshot.files.has("unsafe-ancestor/secret.txt"), false);
    assert.ok(result.capture.gaps.some((item) => item.scope === "unsafe-ancestor/secret.txt" && item.reason.includes("symbolic-link ancestor")));
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("unexpected watcher closure and logical identity replacement fail closed", async () => {
  const directory = await createRepository();
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "18181818-1818-4818-8818-181818181818" }, watcherFactory: () => watcher });
  const observationContext = context(directory, "90909090909090909090909090909090");
  try {
    const closing = await boundary.beginWindow(observationContext);
    watcher.emit("close");
    const closed = await boundary.endWindow(closing);
    assert.equal(closed.completeness, "degraded");
    assert.ok(closed.capture.gaps.some((item) => item.kind === "watcher_unavailable"));

    const replacement = await boundary.beginWindow({
      ...observationContext,
      repositoryId: "repo_22222222222222222222222222222222",
      worktreeId: "wt_22222222222222222222222222222222",
    });
    assert.ok(replacement.before.gaps.some((item) => item.kind === "root_replaced"));
    await boundary.endWindow(replacement);
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("symlink escape is excluded with explicit degraded coverage", async (testContext) => {
  const directory = await createRepository();
  const outside = mkdtempSync(join(tmpdir(), "patchmesh-observation-outside-"));
  try {
    try {
      symlinkSync(outside, join(directory, "unsafe-link"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        testContext.skip("symbolic links require an unavailable Windows privilege");
        return;
      }
      throw error;
    }
    const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "12121212-1212-4212-8212-121212121212" } });
    const capture = await boundary.captureBefore(context(directory, "30303030303030303030303030303030"));
    assert.equal(capture.snapshot.files.has("unsafe-link"), false);
    assert.ok(capture.gaps.some((item) => item.scope === "unsafe-link" && item.reason.includes("escapes")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("periodic reconciliation degrades when the watcher loses an event", async () => {
  const directory = await createRepository();
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const reconciliation = reconciliationHarness();
  const boundary = new NodeObservationBoundary({ source: { kind: "watcher", sourceId: "source_observation", instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, reconciliationEveryWindows: 1, reconciliationScheduler: reconciliation.scheduler, watcherFactory: () => watcher });
  const observationContext = context(directory, "dddddddddddddddddddddddddddddddd");
  try {
    const window = await boundary.beginWindow(observationContext);
    writeFileSync(join(directory, "lost-event.txt"), "lost\n");
    const initialResult = await boundary.endWindow(window);
    assert.equal(initialResult.capture.snapshot.files.has("lost-event.txt"), false);
    await reconciliation.runNext();
    const next = await boundary.beginWindow(observationContext);
    const result = await boundary.endWindow(next);
    assert.equal(result.completeness, "degraded");
    assert.ok(result.capture.gaps.some((gap) => gap.kind === "reconciliation_mismatch"));
  } finally {
    await boundary.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
