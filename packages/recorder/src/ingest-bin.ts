#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { findWorktreeRoot } from "./identity.js";
import { ingestJournal, recordTurnEffects } from "./ingest.js";
import { journalPathFor } from "./journal.js";
import { LEDGER_DIRECTORY, ledgerPathFor, snapshotPathFor } from "./record.js";

function debug(message: string): void {
  if (process.env["PATCHMESH_RECORDER_DEBUG"] !== undefined) {
    process.stderr.write(`patchmesh-ingest: ${message}\n`);
  }
}

/**
 * Drain the journal into the ledger. Runs once per session (or on demand), so it can
 * afford the protocol validation cost the per-tool-call hook cannot.
 *
 * Also always exits 0: it is wired to a session lifecycle hook, and a failed ingest must
 * not surface as a broken session. Entries stay in the journal for the next run.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const explicitRoot = argv[0];
    const worktreeRoot = explicitRoot ?? findWorktreeRoot(process.cwd());
    if (worktreeRoot === null) {
      debug("no git worktree found");
      return 0;
    }
    const result = ingestJournal({
      worktreeRoot,
      journalPath: journalPathFor(worktreeRoot, LEDGER_DIRECTORY),
      ledgerPath: ledgerPathFor(worktreeRoot),
    });
    debug(`ingested ${result.ingested}, skipped ${result.skipped}, turns ${result.turns}`);

    // Effects are observed after the journal is safely drained: a failure here leaves the
    // recorded calls in the ledger rather than stranding them in an unclaimed journal.
    const effects = await recordTurnEffects({
      worktreeRoot,
      ledgerPath: ledgerPathFor(worktreeRoot),
      snapshotPath: snapshotPathFor(worktreeRoot),
      turn: result.closedTurn,
      calls: result.calls,
    });
    debug(effects.baselineOnly ? "observed baseline only" : `observed ${effects.changed} file change(s)`);
    return 0;
  } catch (error) {
    debug(error instanceof Error ? error.message : "unknown ingest failure");
    return 0;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
