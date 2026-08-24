#!/usr/bin/env -S node
/**
 * Manufactures real, labelled concurrent-write data through the real recorder pipeline.
 *
 * Why this exists: PatchMesh's founding premise -- detecting when concurrent agent work stops
 * being independent -- had (as of 2026-08-22) been exercised exactly seven times, ever, on the
 * live ledger, all from one agent pair across two days, because the author works one agent at a
 * time. Every precision claim and every threshold (`IDLE_GAP_MINUTES = 30`) rests on that sample
 * of 7. This harness cannot manufacture *real* agent behaviour, but it can manufacture *real
 * recorded events*: it drives the actual `appendJournalEntry` / `ingestJournal` /
 * `recordTurnEffects` pipeline (the same functions `patchmesh-record` and `patchmesh-ingest`
 * call) over real file writes in a scratch git checkout, so the resulting ledger holds genuine
 * rows produced by genuine code, not fabricated rows injected to look like some.
 *
 * The one thing it does *not* get from real wall-clock time is the gap between writes: a real
 * agent session can span hours, and this needs to be runnable in seconds. `appendJournalEntry`
 * and `recordTurnEffects` both take their timestamp as an explicit argument rather than always
 * reading the clock (`journal.ts`: "captured when the tool call completed, not when it was
 * later ingested"; `effects.ts`'s `now` option exists so a test's calls and a test's file
 * changes can share one clock). That is the seam this harness uses, and the only place it
 * departs from a literal hook invocation: every timestamp below is supplied, not measured. See
 * `docs/measurements/concurrency-harness.md` for what that does and does not entitle you to
 * conclude from the result.
 *
 * Safety: this must never touch the developer's real checkout or real ledger. See
 * `assertScratchIsolation` below -- it is checked before anything is written.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  appendJournalEntry,
  ingestJournal,
  journalPathFor,
  LEDGER_DIRECTORY,
  ledgerPathFor,
  recordTurnEffects,
  snapshotPathFor,
} from "../../packages/recorder/dist/index.js";
import { findOverlappingWork, IDLE_GAP_MINUTES } from "../../packages/query/dist/index.js";
import { buildCases, type HarnessCase } from "./scenarios.js";

const HERE = fileURLToPath(import.meta.url);
const CONCURRENCY_DIR = dirname(HERE);
// tools/concurrency -> tools -> repo root. Computed by walking up, not hardcoded, so this still
// finds the real repo root if the tools directory is ever moved.
const REAL_REPO_ROOT = dirname(dirname(CONCURRENCY_DIR));

/** Minutes of separation between two cases' local timelines in the synthetic clock. Purely for
 *  readable, non-colliding ISO timestamps in the manifest -- cases never interact through the
 *  ledger regardless of this value, because every query below filters by that case's own file. */
const CASE_SPACING_MINUTES = 1000;

/** A fixed, arbitrary epoch, not derived from wall-clock time. Every timestamp this harness
 *  writes is `HARNESS_EPOCH_MS + (case offset + action offset) minutes`, so a run is byte-for-
 *  byte reproducible regardless of when or how long it actually takes to execute. */
const HARNESS_EPOCH_MS = Date.parse("2024-01-01T00:00:00.000Z");

function isoAt(caseIndex: number, offsetMinutes: number): string {
  return new Date(HARNESS_EPOCH_MS + (caseIndex * CASE_SPACING_MINUTES + offsetMinutes) * 60_000).toISOString();
}

/**
 * Refuse to run anywhere near the developer's real repository or ledger.
 *
 * Three independent checks, because a single guard failing silently is exactly the failure mode
 * this exists to prevent: the scratch root must live under the OS temp directory, it must not be
 * (or be inside) the real repo root, and its *computed ledger path* must not equal the real
 * ledger path even if the first two checks were somehow satisfied by a symlink or junction.
 */
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
  const realLedger = resolve(join(REAL_REPO_ROOT, ".patchmesh", "ledger.db")).toLowerCase();
  const scratchLedger = resolve(ledgerPathFor(scratchRoot)).toLowerCase();
  if (scratchLedger === realLedger) {
    throw new Error(`refusing to run: computed ledger path equals the real repo's ledger.db`);
  }
}

function turnMarkerPayload(sessionId: string): Record<string, unknown> {
  return { session_id: sessionId, hook_event_name: "UserPromptSubmit" };
}

function toolCallPayload(sessionId: string, kind: "write" | "read", file: string, cwd: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: kind === "write" ? "Write" : "Read",
    tool_input: { file_path: file },
    tool_response: {},
    cwd,
    tool_use_id: randomUUID(),
  };
}

interface CaseResult {
  readonly caseId: string;
  readonly kind: HarnessCase["kind"];
  readonly file: string;
  readonly groundTruth: HarnessCase["groundTruth"];
  readonly constructedGapMinutes: number | undefined;
  readonly detectorVerdict: "flagged" | "sequential" | "no-signal";
  readonly filesObservedForThisPath: number;
  readonly contentionEvidence: unknown;
}

async function replayCase(options: {
  readonly caseIndex: number;
  readonly harnessCase: HarnessCase;
  readonly scratchRoot: string;
  readonly journalPath: string;
  readonly ledgerPath: string;
  readonly snapshotPath: string;
  readonly seenTurn: Set<string>;
}): Promise<{ ingested: number; changed: number }> {
  const { caseIndex, harnessCase, scratchRoot, journalPath, ledgerPath, snapshotPath, seenTurn } = options;
  const workersByLabel = new Map(harnessCase.workers.map((w) => [w.label, w]));
  let ingested = 0;
  let changed = 0;

  for (const action of harnessCase.actions) {
    const worker = workersByLabel.get(action.worker);
    if (worker === undefined) throw new Error(`case ${harnessCase.caseId}: unknown worker "${action.worker}"`);
    const at = isoAt(caseIndex, action.offsetMinutes);

    if (!seenTurn.has(worker.sessionId)) {
      appendJournalEntry(journalPath, turnMarkerPayload(worker.sessionId), at);
      seenTurn.add(worker.sessionId);
    }

    if (action.kind === "write") {
      const filePath = join(scratchRoot, harnessCase.file);
      mkdirSync(dirname(filePath), { recursive: true });
      // Real bytes on disk, distinct every time, so the snapshot diff has a genuine change to
      // observe rather than a no-op write that happens to share a byte-identical hash.
      writeFileSync(filePath, `case=${harnessCase.caseId} worker=${action.worker} at=${at}\n`, "utf8");
    }

    appendJournalEntry(journalPath, toolCallPayload(worker.sessionId, action.kind, harnessCase.file, scratchRoot), at);

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

  return { ingested, changed };
}

export async function runHarness(options: { readonly clean: boolean }): Promise<{
  readonly scratchRoot: string;
  readonly ledgerPath: string;
  readonly totalIngested: number;
  readonly totalChanged: number;
  readonly results: readonly CaseResult[];
}> {
  const scratchRoot = mkdtempSync(join(tmpdir(), "patchmesh-concurrency-"));
  assertScratchIsolation(scratchRoot);

  try {
    execFileSync("git", ["init", "-q"], { cwd: scratchRoot });
  } catch (error) {
    throw new Error(`git init failed in scratch checkout ${scratchRoot}: ${String(error)}`);
  }

  const journalPath = journalPathFor(scratchRoot, LEDGER_DIRECTORY);
  const ledgerPath = ledgerPathFor(scratchRoot);
  const snapshotPath = snapshotPathFor(scratchRoot);
  assertScratchIsolation(scratchRoot); // re-check after ledgerPathFor is resolvable, cheap insurance

  const cases = buildCases();
  const seenTurn = new Set<string>();
  let totalIngested = 0;
  let totalChanged = 0;

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const { ingested, changed } = await replayCase({
      caseIndex,
      harnessCase: cases[caseIndex]!,
      scratchRoot,
      journalPath,
      ledgerPath,
      snapshotPath,
      seenTurn,
    });
    totalIngested += ingested;
    totalChanged += changed;
  }

  // One window, generous enough to cover every case's local timeline regardless of index, used
  // for every query below. Correctness does not depend on its size: each query also filters by
  // that case's own unique file, so a window wide enough to include a neighbouring case's events
  // would still never see them under this path.
  const totalSpanMinutes = cases.length * CASE_SPACING_MINUTES + 500;
  const queryNow = new Date(HARNESS_EPOCH_MS + totalSpanMinutes * 60_000);

  const results: CaseResult[] = cases.map((harnessCase) => {
    const overlap = findOverlappingWork({
      worktreeRoot: scratchRoot,
      ledgerPath,
      path: harnessCase.file,
      withinMinutes: totalSpanMinutes,
      now: () => queryNow,
    });
    const flagged = overlap.overlaps.length > 0;
    const verdict: CaseResult["detectorVerdict"] = flagged ? "flagged" : overlap.sequential > 0 ? "sequential" : "no-signal";
    return {
      caseId: harnessCase.caseId,
      kind: harnessCase.kind,
      file: harnessCase.file,
      groundTruth: harnessCase.groundTruth,
      constructedGapMinutes: harnessCase.constructedGapMinutes,
      detectorVerdict: verdict,
      filesObservedForThisPath: overlap.filesObserved,
      contentionEvidence: flagged ? overlap.overlaps[0]!.contention : null,
    };
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    note: "All 'at' timestamps below are synthetic (see harness.ts header); everything else -- file bytes, journal format, event schema, SQLite rows -- came from the real recorder pipeline.",
    scratchRoot,
    ledgerPath,
    idleGapMinutesConstant: IDLE_GAP_MINUTES,
    totalIngestedEvents: totalIngested,
    totalFileChangedEvents: totalChanged,
    cases: cases.map((c, caseIndex) => ({
      ...c,
      actions: c.actions.map((a) => ({ ...a, atIso: isoAt(caseIndex, a.offsetMinutes) })),
    })),
    results,
  };

  const outDir = join(CONCURRENCY_DIR, "output");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "last-run-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  printSummary(manifest);

  if (options.clean) {
    rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nScratch checkout kept at: ${scratchRoot}`);
    console.log(`Inspect it directly with, e.g.: patchmesh overlaps --database "${ledgerPath}" --within ${totalSpanMinutes}`);
  }

  return { scratchRoot, ledgerPath, totalIngested, totalChanged, results };
}

function printSummary(manifest: {
  readonly totalIngestedEvents: number;
  readonly totalFileChangedEvents: number;
  readonly idleGapMinutesConstant: number;
  readonly results: readonly CaseResult[];
}): void {
  console.log(`patchmesh-concurrency-harness: ${manifest.totalIngestedEvents} tool call(s) ingested, ${manifest.totalFileChangedEvents} file.changed event(s) observed`);
  console.log(`IDLE_GAP_MINUTES = ${manifest.idleGapMinutesConstant}\n`);

  const clear = manifest.results.filter((r) => r.groundTruth !== "undetermined");
  console.log("Clear cases (ground truth asserted independently of the detector):");
  let matches = 0;
  for (const r of clear) {
    const expectedFlag = r.groundTruth === "contended";
    const gotFlag = r.detectorVerdict === "flagged";
    const ok = expectedFlag === gotFlag;
    if (ok) matches += 1;
    console.log(`  [${ok ? "MATCH" : "MISMATCH"}] ${r.caseId}: expected ${r.groundTruth}, detector said ${r.detectorVerdict}`);
  }
  console.log(`  ${matches}/${clear.length} matched.\n`);

  const probes = manifest.results.filter((r) => r.groundTruth === "undetermined");
  console.log("Boundary probes (no ground truth asserted -- reporting where the constant flips the verdict):");
  for (const r of probes.sort((a, b) => (a.constructedGapMinutes ?? 0) - (b.constructedGapMinutes ?? 0))) {
    console.log(`  gap=${r.constructedGapMinutes}min -> ${r.detectorVerdict}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const clean = process.argv.includes("--clean");
  runHarness({ clean }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
