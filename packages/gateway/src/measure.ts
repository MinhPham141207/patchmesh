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
/**
 * Bumped from 1 when `source`, `ok`, `agentId` and `trigger` were added. A reader that counts
 * adoption must be able to tell a v1 row -- which cannot say whether an agent or a hook asked
 * -- from a v2 row that can.
 */
const MEASUREMENT_VERSION = 2;

/** Stop recording rather than grow without bound; the file is telemetry, not a ledger. */
const MAX_MEASUREMENT_BYTES = 4 * 1024 * 1024;

/**
 * Where an answer was asked for, so a count of them means something.
 *
 * Every row used to look identical, which made three different things indistinguishable: an
 * agent choosing to call a tool, a hook injecting context nobody asked for, and a benchmark
 * script measuring latency. A local probe of the server wrote 25 rows that read exactly like
 * adoption. Adoption is the number this file exists to support, so the file has to say which
 * of those it is watching. See docs/problems/PM-15.
 */
export type AnswerSource = "mcp" | "session_start" | "cli" | "probe";

export interface AnswerMeasurement {
  readonly tool: string;
  /** Which surface asked. `mcp` is the only one that is evidence of an agent choosing to ask. */
  readonly source: AnswerSource;
  /** The path the caller asked about, which is what a later join needs to test displacement. */
  readonly path?: string | undefined;
  /**
   * Who asked, when the surface knows. Present for the session-start hook, which derives the
   * agent from the host's session id, and absent over MCP, where the protocol carries no
   * caller identity -- an absence worth seeing rather than papering over.
   */
  readonly agentId?: string | null | undefined;
  /** For the session-start hook: which of startup, resume, clear or compact fired it. */
  readonly trigger?: string | undefined;
  /**
   * Whether the caller got an answer. Failures used to be invisible: the tools fail soft and
   * return prose, and only the success path recorded anything, so a call that errored left no
   * trace at all and the ledger and this file disagreed about how many calls happened.
   */
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
