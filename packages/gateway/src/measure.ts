import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * When the `SessionStart` hook first pushed context into a session, recorded so the time-to-
 * resume measurement has a treatment boundary at all.
 *
 * This used to also record every MCP tool call -- an agent choosing to ask `patchmesh_recap`
 * and a shell script benchmarking the same stdio surface wrote identically-shaped rows, because
 * the protocol carries no caller identity to tell them apart. A local latency probe wrote 25 of
 * them; a later benchmark wrote 30 more; the count they inflated was never recoverable once
 * mixed in. Adoption is now read from the ledger's `tool.requested` rows instead
 * (`patchmesh-query`'s `adoption.ts`), which the MCP protocol *does* attribute to a session and
 * which nothing outside a real call can produce. See docs/problems/PM-15.
 *
 * What is left here is the one thing the ledger cannot answer: the session-start binary only
 * reads the ledger and never writes an event, so its pushes leave no trace anywhere except this
 * file. `packages/query/src/resume.ts`'s `treatmentBoundaryFrom` reads it for exactly that
 * timestamp; `patchmesh-query`'s adoption count cannot serve that question because it is not an
 * adoption question at all -- it is "when did the hook first fire", not "did an agent ask".
 *
 * Size is recorded in bytes, not tokens. A tokenizer is a dependency and a version, and this
 * runs inside the hook call; bytes are exact, cheap, and a stable proxy at roughly four to one.
 *
 * Writing is best effort and never observable by the caller. A measurement that can break an
 * answer is worse than no measurement.
 */

const MEASUREMENT_FILENAME = "answers.ndjson";
/**
 * Bumped from 1 when `source`, `ok`, `agentId` and `trigger` were added. A reader that counts
 * adoption must be able to tell a v1 row -- which cannot say whether an agent or a hook asked
 * -- from a v2 row that can.
 */
const MEASUREMENT_VERSION = 2;

/** Stop recording rather than grow without bound; the file is telemetry, not a ledger. */
const MAX_MEASUREMENT_BYTES = 4 * 1024 * 1024;

/**
 * Narrowed to the one source `recordAnswer` can still tell the truth about.
 *
 * This used to be `"mcp" | "session_start" | "cli" | "probe"`. `"cli"` was never produced by
 * anything; `"mcp"` and `"probe"` could never be told apart because the MCP protocol carries no
 * caller identity, so any stdio client -- a real agent or a benchmark script -- produced the
 * same shape of row. The only caller left is the `SessionStart` hook, which derives a real
 * agent id from the host's session id, so a type of one value documents that this file no
 * longer claims to count calls it cannot attribute.
 */
export type AnswerSource = "session_start";

export interface AnswerMeasurement {
  readonly tool: string;
  readonly source: AnswerSource;
  /** Who asked. The session-start hook derives this from the host's session id. */
  readonly agentId?: string | null | undefined;
  /** Which of startup, resume, clear or compact fired the hook. */
  readonly trigger?: string | undefined;
  /** Whether the injection produced content, so an empty push is not read as a real one. */
  readonly ok?: boolean | undefined;
  readonly answerBytes: number;
  /** How much the answer actually carried, so an empty answer is not read as a cheap one. */
  readonly items: number;
  readonly withheld: number;
}

export function measurementPathFor(worktreeRoot: string, directory: string): string {
  return join(worktreeRoot, directory, MEASUREMENT_FILENAME);
}

/**
 * Set `PATCHMESH_MEASURE=0` to run the server without writing to the file that measures it.
 *
 * Benchmarking the read path used to inflate the adoption count it was benchmarking. Measuring
 * a system should not be a way of changing its numbers.
 */
function measurementDisabled(): boolean {
  const setting = process.env["PATCHMESH_MEASURE"];
  return setting === "0" || setting === "false";
}

export function recordAnswer(
  measurementPath: string,
  measurement: AnswerMeasurement,
  at = new Date().toISOString(),
): void {
  if (measurementDisabled()) return;
  try {
    try {
      if (statSync(measurementPath).size > MAX_MEASUREMENT_BYTES) return;
    } catch {
      // No file yet, which is the normal first call.
    }
    const line = JSON.stringify({ v: MEASUREMENT_VERSION, at, ...measurement });
    mkdirSync(dirname(measurementPath), { recursive: true });
    appendFileSync(measurementPath, `${line}\n`, "utf8");
  } catch {
    // Never surfaces. The caller asked a question, not for telemetry to succeed.
  }
}
