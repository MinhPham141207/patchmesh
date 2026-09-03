import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, ingestJournal, journalPathFor, LEDGER_DIRECTORY, ledgerPathFor } from "patchmesh-recorder";
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

test("an unwired repository reports host adapters as not installed, not as broken", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root });
    // With the adapter-based checks, an unwired repository is reported as healthy: each host
    // adapter returns "ok" for not-installed, because a missing optional host is not an error.
    assert.equal(report.healthy, true);
    assert.equal(statusOf(report, "Claude Code (observed)"), "ok");
    assert.match(detailOf(report, "Claude Code (observed)"), /not installed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wired repository with no ledger yet is healthy, because nothing is wrong with it", async () => {
  const root = temporaryRepository();
  try {
    const binary = join(root, "recorder", "dist", "bin.js");
    mkdirSync(join(root, "recorder", "dist"), { recursive: true });
    writeFileSync(binary, "", "utf8");
    writeHooks(root, `node "${binary}"`, ALL_HOOKS);

    const report = await diagnose({ worktreeRoot: root });
    // Warnings, not failures: a configured repository whose agent has not run yet is the
    // expected state directly after `init`, and telling that user something is broken would
    // send them to fix a working install.
    assert.equal(report.healthy, true);
    assert.equal(statusOf(report, "Claude Code (observed)"), "ok");
    assert.equal(statusOf(report, "ledger"), "warn");
    assert.match(detailOf(report, "ledger"), /nothing has been recorded/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a journal that has waited a day means the drain is not running", async () => {
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
    const report = await diagnose({ worktreeRoot: root, now: later });
    assert.equal(statusOf(report, "journal"), "warn");
    assert.match(detailOf(report, "journal"), /not draining/u);

    const fresh = await diagnose({ worktreeRoot: root });
    assert.equal(statusOf(fresh, "journal"), "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old Node is a failure, because the event store cannot open at all", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root, nodeVersion: "v20.11.0" });
    assert.equal(statusOf(report, "node"), "fail");
    assert.equal(report.healthy, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the report names the host events are stamped with", async () => {
  const previous = process.env.PATCHMESH_HOST;
  try {
    delete process.env.PATCHMESH_HOST;
    const report = await diagnose({ worktreeRoot: null });
    assert.equal(statusOf(report, "host"), "ok");
    assert.equal(detailOf(report, "host"), "claude-code");

    process.env.PATCHMESH_HOST = "opencode";
    const overridden = await diagnose({ worktreeRoot: null });
    assert.equal(detailOf(overridden, "host"), "opencode");
    assert.match(renderDoctor(overridden, false), /host: opencode/u);
  } finally {
    if (previous === undefined) delete process.env.PATCHMESH_HOST;
    else process.env.PATCHMESH_HOST = previous;
  }
});

test("outside a git repository the report says so instead of guessing", async () => {
  const report = await diagnose({ worktreeRoot: null });
  assert.equal(report.healthy, false);
  assert.equal(statusOf(report, "repository"), "fail");
});

test("the report is machine-readable on request", async () => {
  const report = await diagnose({ worktreeRoot: null });
  const parsed = JSON.parse(renderDoctor(report, true)) as DoctorReport;
  assert.equal(parsed.healthy, false);
  assert.equal(Array.isArray(parsed.checks), true);
});

/** A repository with a real ledger in it, built through the recorder rather than by hand. */
function recordedRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-doctor-ledger-"));
  execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
  appendJournalEntry(
    journalPathFor(root, LEDGER_DIRECTORY),
    {
      session_id: "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(root, "a.ts") },
      tool_response: {},
    },
    new Date().toISOString(),
  );
  ingestJournal({
    worktreeRoot: root,
    journalPath: journalPathFor(root, LEDGER_DIRECTORY),
    ledgerPath: ledgerPathFor(root),
  });
  return root;
}

test("the ledger's size is reported before it is a problem, so growth is visible", async () => {
  const root = recordedRepository();
  try {
    const report = await diagnose({ worktreeRoot: root });
    assert.equal(statusOf(report, "ledger"), "ok");
    // Nothing prunes on its own, so the number a user would act on has to be on the screen
    // during the months in which acting is still cheap.
    assert.match(detailOf(report, "ledger"), /\d+(\.\d+)?(B|KB|MB|GB)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ledger past the size budget is a warning that names the command, never an automatic delete", async () => {
  const root = recordedRepository();
  try {
    const report = await diagnose({ worktreeRoot: root, largeLedgerBytes: 1 });
    assert.equal(statusOf(report, "ledger"), "warn");
    assert.match(detailOf(report, "ledger"), /nothing prunes the ledger on its own/u);
    // Retention deletes history, and history is the product. The fix is offered, not taken.
    const fix = report.checks.find((check) => check.name === "ledger")?.fix ?? "";
    assert.match(fix, /patchmesh prune --older-than/u);
    // A warning, never a failure: a large ledger is a working ledger, and `doctor`'s exit code
    // gates other things. Size must not be able to turn a recording repository into a broken one.
    assert.notEqual(statusOf(report, "ledger"), "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Wire the Claude hooks against a binary that exists, so only the OpenCode state varies. */
function wiredRepository(): string {
  const root = temporaryRepository();
  const binary = join(root, "recorder", "dist", "bin.js");
  mkdirSync(join(root, "recorder", "dist"), { recursive: true });
  writeFileSync(binary, "", "utf8");
  writeHooks(root, `node "${binary}"`, ALL_HOOKS);
  return root;
}

test("an uninstalled OpenCode host is plain information, never a failure", async () => {
  const root = wiredRepository();
  try {
    const report = await diagnose({ worktreeRoot: root });
    assert.equal(statusOf(report, "OpenCode (observed)"), "ok");
    assert.match(detailOf(report, "OpenCode (observed)"), /not installed/u);
    // OpenCode is a second host beside the Claude hooks; not having it says nothing about
    // whether recording works here, so it must not move the health verdict.
    assert.equal(report.healthy, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an OpenCode plugin pointing at an existing binary is reported as installed", async () => {
  const root = wiredRepository();
  try {
    // The repo-relative committed form, resolved against the worktree like every hook command.
    const relativeBinary = join("packages", "recorder", "dist", "bin.js");
    mkdirSync(join(root, "packages", "recorder", "dist"), { recursive: true });
    writeFileSync(join(root, relativeBinary), "", "utf8");
    mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    writeFileSync(
      join(root, ".opencode", "plugins", "patchmesh.mjs"),
      `const RECORDER_BIN = "${relativeBinary.replaceAll("\\\\", "/")}";\n`,
      "utf8",
    );
    const report = await diagnose({ worktreeRoot: root });
    assert.equal(statusOf(report, "OpenCode (observed)"), "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an OpenCode plugin naming a missing recorder warns but never fails doctor", async () => {
  const root = wiredRepository();
  try {
    mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    writeFileSync(
      join(root, ".opencode", "plugins", "patchmesh.mjs"),
      `const RECORDER_BIN = ${JSON.stringify(join(root, "absent", "bin.js"))};\n`,
      "utf8",
    );
    const report = await diagnose({ worktreeRoot: root });
    assert.equal(statusOf(report, "OpenCode (observed)"), "warn");
    assert.match(detailOf(report, "OpenCode (observed)"), /records nothing/u);
    // The Claude-side recording this verdict is about is untouched by a stale optional plugin.
    assert.equal(report.healthy, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The EINVAL refusal is Node-on-Windows behavior; elsewhere a bare name on the PATH is fine.
test("a bare recorder name reachable only through a .cmd shim warns instead of being blessed", { skip: process.platform !== "win32" }, async () => {
  const root = wiredRepository();
  const shimDirectory = mkdtempSync(join(tmpdir(), "patchmesh-doctor-shim-"));
  const previousPath = process.env["PATH"];
  try {
    writeFileSync(join(shimDirectory, "patchmesh-fake.cmd"), "@echo off\r\n", "utf8");
    mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    writeFileSync(
      join(root, ".opencode", "plugins", "patchmesh.mjs"),
      'const RECORDER_BIN = "patchmesh-fake";\n',
      "utf8",
    );
    process.env["PATH"] = shimDirectory;
    const report = await diagnose({ worktreeRoot: root });
    // The name is on the PATH, but only as the kind of shim the plugin's spawn is refused;
    // saying ok here would bless an install that records nothing.
    assert.equal(statusOf(report, "OpenCode (observed)"), "warn");
    assert.match(detailOf(report, "OpenCode (observed)"), /\.cmd shim/u);
    assert.equal(report.healthy, true);
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    rmSync(shimDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("version check reports up to date when installed matches latest", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root, installedVersion: "1.2.3", latestVersion: "1.2.3" });
    assert.equal(statusOf(report, "version"), "ok");
    assert.match(detailOf(report, "version"), /up to date/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version check warns when a newer version is available", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root, installedVersion: "1.2.3", latestVersion: "1.3.0" });
    assert.equal(statusOf(report, "version"), "warn");
    assert.match(detailOf(report, "version"), /installed 1\.2\.3, latest 1\.3\.0/u);
    const fix = report.checks.find((check) => check.name === "version")?.fix ?? "";
    assert.match(fix, /npm install -g patchmesh@latest/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version check warns on major version behind", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root, installedVersion: "0.3.2", latestVersion: "2.0.0" });
    assert.equal(statusOf(report, "version"), "warn");
    assert.match(detailOf(report, "version"), /installed 0\.3\.2, latest 2\.0\.0/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version check is ok when fetch fails", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root, installedVersion: "1.2.3", latestVersion: null });
    assert.equal(statusOf(report, "version"), "ok");
    assert.match(detailOf(report, "version"), /could not check npm/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version check is ok when installed version is unknown", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root, installedVersion: "unknown", latestVersion: "1.0.0" });
    assert.equal(statusOf(report, "version"), "ok");
    assert.match(detailOf(report, "version"), /installed version unknown/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports per-host status with tier", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root });
    // Every registered adapter produces a check with the host name and tier in the check name.
    const hostChecks = report.checks.filter((check) => check.name.includes("("));
    assert.ok(hostChecks.length >= 3, "should have checks for Claude Code, OpenCode, Codex, and Generic MCP");
    assert.ok(hostChecks.some((check) => check.name === "Claude Code (observed)"), "Claude Code check with tier");
    assert.ok(hostChecks.some((check) => check.name === "OpenCode (observed)"), "OpenCode check with tier");
    assert.ok(hostChecks.some((check) => check.name === "Codex (observed)"), "Codex check with tier");
    assert.ok(hostChecks.some((check) => check.name === "Generic MCP (declared)"), "Generic MCP check with tier");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor does not fail for uninstalled hosts", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root });
    // Uninstalled hosts report "ok", not "fail" or "warn".
    assert.equal(statusOf(report, "OpenCode (observed)"), "ok");
    assert.equal(statusOf(report, "Codex (observed)"), "ok");
    assert.equal(statusOf(report, "Generic MCP (declared)"), "ok");
    // The overall report is healthy because uninstalled optional hosts are not errors.
    assert.equal(report.healthy, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports codex status with tier when installed", async () => {
  const root = temporaryRepository();
  try {
    // Create a .mcp.json with the Codex MCP server registered.
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "patchmesh-codex": { type: "stdio", command: "patchmesh-mcp" },
      },
    }), "utf8");
    const report = await diagnose({ worktreeRoot: root });
    assert.equal(statusOf(report, "Codex (observed)"), "ok");
    assert.match(detailOf(report, "Codex (observed)"), /Codex MCP server registered/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports generic-mcp status with tier", async () => {
  const root = temporaryRepository();
  try {
    const report = await diagnose({ worktreeRoot: root });
    assert.equal(statusOf(report, "Generic MCP (declared)"), "ok");
    assert.match(detailOf(report, "Generic MCP (declared)"), /declared-tier participation/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
