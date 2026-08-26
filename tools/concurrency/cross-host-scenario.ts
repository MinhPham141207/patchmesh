#!/usr/bin/env -S node
/**
 * Wave B acceptance: cross-host contention, end to end.
 *
 * Two hosts, one ledger, one file. A Claude Code agent (task-attributed) writes a file at
 * T+0 and stays active until T+40; an OpenCode agent (null task by construction, per Task
 * 1's keying-by-worker) writes the same file at T+20. `findOverlappingWork` must report one
 * overlap naming both hosts' agents, with the contention evidence intact. Everything before
 * this in F-01 was scaffolding; this is the acceptance test that matters.
 *
 * Like `harness.ts`, this drives the real recorder pipeline (`appendJournalEntry` /
 * `ingestJournal` / `recordTurnEffects`) over real file writes in a scratch git checkout.
 * Two departures from a literal hook invocation, stated plainly: timestamps are supplied,
 * not measured, so a run is byte-for-byte reproducible; and the ledger traffic never passes
 * through `bin.ts` at all -- the payloads are hand-built Claude-shaped translations stamped
 * with `patchmesh_host`, matching what `bin.ts` journals, not produced by it. So this gate
 * exercises ingest -> effects -> overlap only; envelope parsing and adapter translation are
 * covered by `packages/recorder/test/bin-host.test.ts` and by this file's latency run, which
 * does drive the real binary. See that test for how the journal shapes are produced.
 *
 * With `--latency`, instead measures plugin spawn latency: N timed spawns of the real
 * `bin.js --host opencode` with a fixture envelope on stdin, in a throwaway worktree, so
 * nothing touches any real ledger. This measures the recorder cost as the OpenCode plugin
 * experiences it; Bun-side relay overhead is NOT included (see F-01 §9).
 *
 * Safety: identical scratch-isolation discipline to `harness.ts`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  agentIdForSession,
  appendJournalEntry,
  ingestJournal,
  journalPathFor,
  LEDGER_DIRECTORY,
  ledgerPathFor,
  redactHookPayload,
  recordTurnEffects,
  snapshotPathFor,
} from "../../packages/recorder/dist/index.js";
import { SqliteEventStore } from "../../packages/storage/dist/index.js";
import { findOverlappingWork, IDLE_GAP_MINUTES } from "../../packages/query/dist/index.js";

const HERE = fileURLToPath(import.meta.url);
const CONCURRENCY_DIR = dirname(HERE);
const REAL_REPO_ROOT = dirname(dirname(CONCURRENCY_DIR));

/** Fixed epoch; every timestamp below is an offset from this, never wall-clock. */
const HARNESS_EPOCH_MS = Date.parse("2024-06-01T00:00:00.000Z");

function isoAt(offsetMinutes: number): string {
  return new Date(HARNESS_EPOCH_MS + offsetMinutes * 60_000).toISOString();
}

/** The contended file, repo-relative POSIX. */
const CONTESTED_FILE = "src/shared-config.ts";

const CLAUDE_SESSION = "crosshost-claude-agent-a";
const OPENCODE_SESSION = "crosshost-opencode-agent-b";

/**
 * The timeline, as data. Units are the harness's synthetic minutes, the same scale
 * `IDLE_GAP_MINUTES` (30) is defined on: the later write lands 20 minutes into the earlier
 * writer's activity, inside the idle-gap allowance, and the earlier writer is still going
 * 20 minutes after it. Both halves of the contention rule hold by construction.
 */
const TIMELINE = [
  { host: "claude-code", session: CLAUDE_SESSION, at: 0, kind: "write" },
  { host: "opencode", session: OPENCODE_SESSION, at: 20, kind: "write" },
  { host: "claude-code", session: CLAUDE_SESSION, at: 40, kind: "read" },
] as const;

type TimelineEntry = (typeof TIMELINE)[number];

function assertScratchIsolation(scratchRoot: string): void {
  const scratch = resolve(scratchRoot).toLowerCase();
  const real = resolve(REAL_REPO_ROOT).toLowerCase();
  const tmp = resolve(tmpdir()).toLowerCase();
  const sepLower = sep.toLowerCase();

  if (scratch !== tmp && !scratch.startsWith(tmp + sepLower)) {
    throw new Error(`refusing to run: scratch root "${scratchRoot}" is not inside the OS temp directory`);
  }
  if (scratch === real || scratch.startsWith(real + sepLower)) {
    throw new Error(`refusing to run: scratch root "${scratchRoot}" is inside the real PatchMesh repo`);
  }
}

/** What bin.ts journals for a Claude Code hook payload, provenance stamp included. */
function claudePayload(session: string, kind: "write" | "read", cwd: string): Record<string, unknown> {
  return {
    session_id: session,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: kind === "write" ? "Write" : "Read",
    tool_input: { file_path: join(cwd, CONTESTED_FILE) },
    tool_response: {},
    tool_use_id: `toolu_${session}_${kind}`,
    patchmesh_host: "claude-code",
  };
}

/**
 * What bin.ts journals for an OpenCode `tool.execute.after` call: the Claude-shaped
 * translation of the native envelope, provenance stamped. The `tool_use_id` is the
 * envelope's `callID`, which every captured envelope carries and `translateOpencodeRecord`
 * journals -- planting it keeps the shape identical to production output. The null task
 * does NOT come from that field's absence: a `tool_use_id` never opens a task. Tasks are
 * opened only by turn markers (`taskIdForTurn` fires on UserPromptSubmit alone, per
 * ingest.ts), and real OpenCode traffic never sends one -- so this payload carries no
 * marker anywhere in its session's timeline, and the call records with `taskId: null`.
 */
function opencodePayload(session: string, kind: "write" | "read", cwd: string): Record<string, unknown> {
  return {
    session_id: session,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: kind === "write" ? "edit" : "read",
    tool_input: { filePath: join(cwd, CONTESTED_FILE) },
    tool_response: {},
    tool_use_id: `call_${session}_${kind}`,
    patchmesh_host: "opencode",
  };
}

function payloadFor(entry: TimelineEntry, cwd: string): Record<string, unknown> {
  return entry.host === "claude-code"
    ? claudePayload(entry.session, entry.kind, cwd)
    : opencodePayload(entry.session, entry.kind, cwd);
}

async function runAcceptance(): Promise<Record<string, unknown>> {
  const scratchRoot = mkdtempSync(join(tmpdir(), "patchmesh-cross-host-"));
  assertScratchIsolation(scratchRoot);

  try {
    execFileSync("git", ["init", "-q"], { cwd: scratchRoot });
  } catch (error) {
    throw new Error(`git init failed in scratch checkout ${scratchRoot}: ${String(error)}`);
  }

  const journalPath = journalPathFor(scratchRoot, LEDGER_DIRECTORY);
  const ledgerPath = ledgerPathFor(scratchRoot);
  const snapshotPath = snapshotPathFor(scratchRoot);

  // The first effects pass only establishes a snapshot baseline and emits nothing, so run it
  // before the timeline -- otherwise the T+0 write would be swallowed as the baseline and the
  // ledger would hold one change instead of the two the contention rule needs.
  const baseline = await recordTurnEffects({
    worktreeRoot: scratchRoot,
    ledgerPath,
    snapshotPath,
    turn: null,
    now: () => isoAt(-1),
  });

  let ingested = 0;
  let changed = 0;
  const seenTurn = new Set<string>();

  for (const entry of TIMELINE) {
    const at = isoAt(entry.at);
    // Turn markers are a Claude Code behaviour (UserPromptSubmit); real OpenCode traffic
    // never sends one, which is exactly why its calls record with null tasks. Planting a
    // marker for the OpenCode session would fabricate a task and erase the condition under
    // test, so only the claude-code session gets one.
    if (entry.host === "claude-code" && !seenTurn.has(entry.session)) {
      appendJournalEntry(
        journalPath,
        redactHookPayload({ session_id: entry.session, hook_event_name: "UserPromptSubmit" }),
        at,
      );
      seenTurn.add(entry.session);
    }

    if (entry.kind === "write") {
      const filePath = join(scratchRoot, CONTESTED_FILE);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${entry.host} wrote at ${at}\n`, "utf8");
    }

    // Journal exactly what bin.ts would have journaled for this host's call: the redacted,
    // provenance-stamped payload.
    appendJournalEntry(journalPath, redactHookPayload(payloadFor(entry, scratchRoot)), at);

    const drained = ingestJournal({ worktreeRoot: scratchRoot, journalPath, ledgerPath, now: () => new Date(at) });
    ingested += drained.ingested;
    const effects = await recordTurnEffects({
      worktreeRoot: scratchRoot,
      ledgerPath,
      snapshotPath,
      turn: drained.closedTurn,
      calls: drained.calls,
      now: () => at,
    });
    changed += effects.changed;
  }

  const queryNow = new Date(HARNESS_EPOCH_MS + 500 * 60_000);
  const overlap = findOverlappingWork({
    worktreeRoot: scratchRoot,
    ledgerPath,
    path: CONTESTED_FILE,
    withinMinutes: 1000,
    now: () => queryNow,
  });

  const claudeAgentId = agentIdForSession(CLAUDE_SESSION);
  const opencodeAgentId = agentIdForSession(OPENCODE_SESSION);

  const store = SqliteEventStore.open(ledgerPath);
  const events = store.read();
  store.close();

  const sourceIds = new Set(events.map((event) => event.source.sourceId));
  const opencodeEvents = events.filter((event) => event.source.sourceId === "source_opencode_hook");
  const opencodeTaskIds = new Set(opencodeEvents.map((event) => String(event.taskId)));

  const assertions: readonly [string, boolean][] = [
    ["exactly one overlap reported", overlap.overlaps.length === 1],
    ["contention evidence present", overlap.overlaps[0]?.contention !== undefined && overlap.overlaps[0]?.contention !== null],
    ["earlier writer is the claude-code agent", overlap.overlaps[0]?.contention?.earlierWorkerAgentId === claudeAgentId],
    ["later writer is the opencode agent", overlap.overlaps[0]?.contention?.laterWorkerAgentId === opencodeAgentId],
    ["both agents identified (no unattributed party)", claudeAgentId !== null && opencodeAgentId !== null],
    ["claude-code provenance in ledger", sourceIds.has("source_claude_code_hook")],
    ["opencode provenance in ledger", sourceIds.has("source_opencode_hook")],
    ["opencode events recorded with null tasks", opencodeEvents.length > 0 && [...opencodeTaskIds].every((id) => id === "null")],
  ];

  const contention = overlap.overlaps[0]?.contention ?? null;

  rmSync(scratchRoot, { recursive: true, force: true });

  const failed = assertions.filter(([, ok]) => !ok);
  for (const [name, ok] of assertions) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  }

  return {
    accepted: failed.length === 0,
    failedAssertions: failed.map(([name]) => name),
    file: CONTESTED_FILE,
    idleGapMinutesConstant: IDLE_GAP_MINUTES,
    ingestedEvents: ingested,
    fileChangedEvents: changed,
    overlapsReported: overlap.overlaps.length,
    contention,
    sourceIds: [...sourceIds].sort(),
    opencodeEventCount: opencodeEvents.length,
  };
}

interface LatencyResult {
  readonly spawns: number;
  readonly warmupsExcluded: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly allExitZero: boolean;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function measureSpawnLatency(): LatencyResult {
  const WARMUPS = 5;
  const MEASURED = 25;
  const binPath = join(REAL_REPO_ROOT, "packages", "recorder", "dist", "bin.js");

  const root = mkdtempSync(join(tmpdir(), "patchmesh-spawn-latency-"));
  assertScratchIsolation(root);
  mkdirSync(join(root, ".git"), { recursive: true });

  try {
    const envelope = JSON.stringify({
      type: "tool.execute.after",
      tool: "edit",
      sessionID: "ses_latency0000000000000000001",
      callID: "call_latency00000000000000001",
      status: "completed",
      input: { filePath: "src/latency-fixture.ts" },
      output: "ok",
    });

    const timings: number[] = [];
    let allExitZero = true;
    for (let i = 0; i < WARMUPS + MEASURED; i += 1) {
      const start = performance.now();
      const result = spawnSync(process.execPath, [binPath, "--host", "opencode"], {
        cwd: root,
        input: envelope,
        encoding: "utf8",
      });
      const elapsed = performance.now() - start;
      if (result.status !== 0) allExitZero = false;
      if (i >= WARMUPS) timings.push(elapsed);
    }

    const sorted = [...timings].sort((a, b) => a - b);
    return {
      spawns: MEASURED,
      warmupsExcluded: WARMUPS,
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p95Ms: Math.round(percentile(sorted, 0.95)),
      maxMs: Math.round(sorted[sorted.length - 1]!),
      allExitZero,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LATENCY_GATE_MS = 300;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const latencyOnly = process.argv.includes("--latency");
  const acceptanceOnly = process.argv.includes("--acceptance");

  const manifest: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    note:
      "Timeline timestamps are synthetic (offsets from a fixed epoch, same seam as harness.ts). " +
      "Latency was measured by timing real spawns of packages/recorder/dist/bin.js --host opencode " +
      "with a fixture envelope on stdin in a throwaway worktree; it covers the recorder cost the " +
      "OpenCode plugin experiences and EXCLUDES Bun-side relay overhead.",
  };

  if (!latencyOnly) {
    console.log("Cross-host contention acceptance:");
    const acceptance = await runAcceptance();
    manifest.acceptance = acceptance;
  }

  if (!acceptanceOnly) {
    console.log("\nPlugin spawn latency (recorder side only):");
    const latency = measureSpawnLatency();
    manifest.latency = latency;
    manifest.latencyGateMs = LATENCY_GATE_MS;
    manifest.latencyGatePasses = latency.p50Ms <= LATENCY_GATE_MS;
    console.log(`  n=${latency.spawns} (+${latency.warmupsExcluded} warmups excluded)  p50=${latency.p50Ms}ms  p95=${latency.p95Ms}ms  max=${latency.maxMs}ms`);
    console.log(`  gate: p50 <= ${LATENCY_GATE_MS}ms -> ${manifest.latencyGatePasses ? "PASS" : "FAIL"}`);
    if (!latency.allExitZero) console.log("  WARNING: at least one spawn exited non-zero");
  }

  const outDir = join(CONCURRENCY_DIR, "output");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "cross-host-last-run.json"), JSON.stringify(manifest, null, 2), "utf8");

  const accepted = (manifest.acceptance as { accepted?: boolean } | undefined)?.accepted !== false;
  const gatePassed = manifest.latencyGatePasses !== false;
  if (!accepted || !gatePassed) process.exitCode = 1;
}
