import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagnose, renderDoctor, type DoctorReport } from "../src/doctor.js";

/**
 * A repository with nothing wired, which is what a user has the moment before they run `init`
 * and, more importantly, what they still have if `init` silently did not take.
 */
function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-doctor-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function statusOf(report: DoctorReport, name: string): string | undefined {
  return report.checks.find((check) => check.name === name)?.status;
}

function detailOf(report: DoctorReport, name: string): string {
  return report.checks.find((check) => check.name === name)?.detail ?? "";
}

/** Write a hook config with one owned command per event, as `init` would. */
function writeHooks(root: string, command: string, events: readonly string[]): void {
  const hooks = Object.fromEntries(
    events.map((event) => [event, [{ matcher: ".*", hooks: [{ type: "command", command }] }]]),
  );
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify({ hooks }), "utf8");
}

const ALL_HOOKS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];

test("an unwired repository is reported as not recording, not as empty", () => {
  const root = temporaryRepository();
  try {
    const report = diagnose({ worktreeRoot: root });
    // The distinction the whole command exists for. Before this, a repository whose hooks were
    // never installed and one that had simply not been worked in yet produced the same
    // observable: an empty ledger and no explanation.
    assert.equal(report.healthy, false);
    assert.equal(statusOf(report, "hooks"), "fail");
    assert.match(renderDoctor(report, false), /PatchMesh is not recording here/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wired repository with no ledger yet is healthy, because nothing is wrong with it", () => {
  const root = temporaryRepository();
  try {
    const binary = join(root, "recorder", "dist", "bin.js");
    mkdirSync(join(root, "recorder", "dist"), { recursive: true });
    writeFileSync(binary, "", "utf8");
    writeHooks(root, `node "${binary}"`, ALL_HOOKS);

    const report = diagnose({ worktreeRoot: root });
    // Warnings, not failures: a configured repository whose agent has not run yet is the
    // expected state directly after `init`, and telling that user something is broken would
    // send them to fix a working install.
    assert.equal(report.healthy, true);
    assert.equal(statusOf(report, "hooks"), "ok");
    assert.equal(statusOf(report, "ledger"), "warn");
    assert.match(detailOf(report, "ledger"), /nothing has been recorded/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooks naming a binary that is not there are reported as recording nothing", () => {
  const root = temporaryRepository();
  try {
    writeHooks(root, `node "${join(root, "recorder", "dist", "bin.js")}"`, ALL_HOOKS);
    const report = diagnose({ worktreeRoot: root });
    // The install failure that motivated this: `npm install -g patchmesh` links only the CLI's
    // own bin, so the config is written correctly and every hook it names is inert.
    assert.equal(report.healthy, false);
    assert.equal(statusOf(report, "recorder"), "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command the host expands is not reported as broken", () => {
  const root = temporaryRepository();
  try {
    const binary = join(root, "packages", "recorder", "dist", "bin.js");
    mkdirSync(join(root, "packages", "recorder", "dist"), { recursive: true });
    writeFileSync(binary, "", "utf8");
    writeHooks(root, 'node "$CLAUDE_PROJECT_DIR/packages/recorder/dist/bin.js"', ALL_HOOKS);

    const report = diagnose({ worktreeRoot: root });
    // Regression. This exact config -- the one this repository runs, recording thousands of
    // events -- was reported as five broken hooks, because the check compared the unexpanded
    // string against the filesystem. A health check that fails a healthy install is worse than
    // no health check.
    assert.equal(report.healthy, true);
    assert.equal(report.checks.some((check) => check.name === "recorder" && check.status === "fail"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a variable this tool cannot expand is unverified rather than broken", () => {
  const root = temporaryRepository();
  try {
    writeHooks(root, 'node "$SOME_OTHER_HOST_DIR/recorder/dist/bin.js"', ALL_HOOKS);
    const report = diagnose({ worktreeRoot: root });
    assert.equal(report.healthy, true);
    assert.match(detailOf(report, "recorder"), /resolved by the host/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partly installed hooks are named, because a missing drain records nothing durable", () => {
  const root = temporaryRepository();
  try {
    const binary = join(root, "recorder", "dist", "bin.js");
    mkdirSync(join(root, "recorder", "dist"), { recursive: true });
    writeFileSync(binary, "", "utf8");
    writeHooks(root, `node "${binary}"`, ["PostToolUse"]);
    const report = diagnose({ worktreeRoot: root });
    assert.equal(statusOf(report, "hooks"), "warn");
    assert.match(detailOf(report, "hooks"), /missing .*Stop/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a journal that has waited a day means the drain is not running", () => {
  const root = temporaryRepository();
  try {
    const binary = join(root, "recorder", "dist", "bin.js");
    mkdirSync(join(root, "recorder", "dist"), { recursive: true });
    writeFileSync(binary, "", "utf8");
    writeHooks(root, `node "${binary}"`, ALL_HOOKS);
    mkdirSync(join(root, ".patchmesh"), { recursive: true });
    writeFileSync(join(root, ".patchmesh", "journal.ndjson"), '{"v":1}\n{"v":1}\n', "utf8");

    // Entries waiting are normal mid-session and abnormal a day later; only the clock
    // separates the two, so the clock is injected rather than waited on.
    const later = () => new Date(Date.now() + 48 * 3_600_000);
    const report = diagnose({ worktreeRoot: root, now: later });
    assert.equal(statusOf(report, "journal"), "warn");
    assert.match(detailOf(report, "journal"), /not draining/u);

    const fresh = diagnose({ worktreeRoot: root });
    assert.equal(statusOf(fresh, "journal"), "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old Node is a failure, because the event store cannot open at all", () => {
  const root = temporaryRepository();
  try {
    const report = diagnose({ worktreeRoot: root, nodeVersion: "v20.11.0" });
    assert.equal(statusOf(report, "node"), "fail");
    assert.equal(report.healthy, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside a git repository the report says so instead of guessing", () => {
  const report = diagnose({ worktreeRoot: null });
  assert.equal(report.healthy, false);
  assert.equal(statusOf(report, "repository"), "fail");
});

test("the report is machine-readable on request", () => {
  const report = diagnose({ worktreeRoot: null });
  const parsed = JSON.parse(renderDoctor(report, true)) as DoctorReport;
  assert.equal(parsed.healthy, false);
  assert.equal(Array.isArray(parsed.checks), true);
});
