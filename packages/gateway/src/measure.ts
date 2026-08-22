import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What each answer cost, recorded so the net-token invariant can be measured rather than
 * assumed.
 *
 * The delivery plan requires that the context PatchMesh returns is smaller than the discovery
 * it displaces, "published, not assumed". Neither side of that comparison is recoverable
 * afterwards: the size of an answer depends on the ledger as it stood at the time, and whether
 * the caller went and read the file anyway is only visible by joining these lines against the
 * calls that follow them. Without this, any later measurement is a reconstruction.
 *
 * Size is recorded in bytes, not tokens. A tokenizer is a dependency and a version, and this
 * runs inside the tool call; bytes are exact, cheap, and a stable proxy at roughly four to one.
 * The conversion belongs to whoever publishes the number, not to the thing being measured.
 *
 * Writing is best effort and never observable by the caller. A measurement that can break an
 * answer is worse than no measurement.
 */

const MEASUREMENT_FILENAME = "answers.ndjson";
const MEASUREMENT_VERSION = 1;

/** Stop recording rather than grow without bound; the file is telemetry, not a ledger. */
const MAX_MEASUREMENT_BYTES = 4 * 1024 * 1024;

export interface AnswerMeasurement {
  readonly tool: string;
  /** The path the caller asked about, which is what a later join needs to test displacement. */
  readonly path?: string | undefined;
  readonly answerBytes: number;
  /** How much the answer actually carried, so an empty answer is not read as a cheap one. */
  readonly items: number;
  readonly withheld: number;
}

export function measurementPathFor(worktreeRoot: string, directory: string): string {
  return join(worktreeRoot, directory, MEASUREMENT_FILENAME);
}

export function recordAnswer(
  measurementPath: string,
  measurement: AnswerMeasurement,
  at = new Date().toISOString(),
): void {
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
