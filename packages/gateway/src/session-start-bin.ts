#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { findWorktreeRoot, ledgerPathFor, LEDGER_DIRECTORY } from "patchmesh-recorder";
import { findOverlappingWork, recapRecentWork, renderOverlap, renderRecap } from "patchmesh-query";
import { measurementPathFor, recordAnswer } from "./measure.js";

/**
 * The read side of the loop: a `SessionStart` hook that hands a new session what the last one
 * did, without anybody choosing to ask.
 *
 * PatchMesh recorded 3,674 events and returned 8 answers in five days -- a ratio of roughly
 * 459 to 1 -- because every hook it installed was write-side. Recall existed two ways and both
 * required a decision: an MCP tool an agent has to know it needs, and a CLI command a person
 * has to type. Agents do not call tools they have not been told they need, so the measurement
 * of the product's value was a measurement of a tool that was never invoked. See
 * docs/problems/PM-01.
 *
 * Everything here follows the recorder's rule: **always exit 0**. This runs before the user's
 * first prompt, and a hook that can fail a session start gets uninstalled after one incident.
 * A missing ledger, an unreadable database, a repository with no history -- all of them mean
 * "say nothing", never "fail".
 *
 * Unlike `patchmesh-record` this may import the heavy packages. It runs once per session
 * rather than once per tool call, so the schema-compilation cost the recorder's flat import
 * graph exists to avoid is paid a single time and is not on the per-call path.
 */

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * How much injected context is worth its own cost.
 *
 * The value claim is that what PatchMesh returns is smaller than the discovery it displaces.
 * An unbounded recap is just the ledger again, and re-reading the ledger is not cheaper than
 * re-reading the code -- so the budget is part of the claim, not a safety valve. Roughly four
 * bytes per token puts this near 1,000 tokens, against a measured recap of about 435.
 */
const MAX_CONTEXT_BYTES = 4_000;

/** Tasks to describe. Bounded twice, in count and in bytes, for the same reason. */
const RECAP_LIMIT = 5;

/** How far back a resumed session cares about. A session resumes from yesterday, not from now. */
const RECAP_WITHIN_MINUTES = 24 * 60;

/**
 * How far back contention is worth warning about, and how many files to name.
 *
 * Much shorter than the recap window. A recap answers "what happened here", where a day of
 * history is useful; contention answers "is somebody else in this file right now", where a
 * day-old collision is history rather than a warning. Four hours matches the default
 * `overlaps` window.
 */
const CONTENTION_WITHIN_MINUTES = 4 * 60;
const CONTENTION_LIMIT = 5;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_PAYLOAD_BYTES) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function debug(message: string): void {
  if (process.env["PATCHMESH_RECORDER_DEBUG"] !== undefined) {
    process.stderr.write(`patchmesh-session-start: ${message}\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Trim to the budget at a line boundary and say what was dropped.
 *
 * Truncating mid-line would hand the agent a half-written task and no way to tell that is what
 * happened. Declaring the withholding is the same rule recap already follows: a summary that
 * hides how much it withheld is not a summary, it is a claim.
 */
export function withinBudget(text: string, maxBytes = MAX_CONTEXT_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (size + cost > maxBytes) break;
    kept.push(line);
    size += cost;
  }
  const dropped = lines.length - kept.length;
  return `${kept.join("\n")}\n(${dropped} further line(s) withheld to stay within the context budget.)`;
}

/**
 * The framing that makes injected context usable rather than just present.
 *
 * Contention goes **first** when there is any. The recap is history and can be read at
 * leisure; contention is the one thing here that can change what the agent does next, and
 * burying it under five paragraphs of task summary is how a warning gets skimmed past. When
 * there is none, nothing about contention is said at all -- "no collisions" in every session
 * is the permanent-`degraded` mistake in a different costume.
 */
export function asAdditionalContext(recap: string, contention?: string | undefined): string {
  const blocks: string[] = ["## PatchMesh — what previous sessions did here", ""];
  if (contention !== undefined && contention !== "") {
    blocks.push(
      "### Another worker was recently in flight over these files",
      "",
      contention,
      "",
    );
  }
  blocks.push(
    recap,
    "",
    "Ask `patchmesh_recap` or `patchmesh_overlapping_work` for more, or run `patchmesh recap`.",
  );
  return blocks.join("\n");
}

/**
 * Files another worker was in flight over, or nothing when there are none.
 *
 * This is the half of PM-01 that recap cannot do. A recap says what happened; contention is
 * the only thing PatchMesh knows that can change what the agent does *next*, and until now it
 * was reachable only by choosing to ask for it -- which is the whole finding behind PM-01, one
 * level in. Agents do not call tools they have not been told they need.
 *
 * It is injected only now that the signal is calibrated. Before the contention rule this query
 * returned twenty files on this repository at any window past eight hours, thirteen of them
 * sequential edits to popular files; pushing that into every session unasked would have spent
 * the agent's context to teach it to ignore the section. See
 * `docs/measurements/overlap-precision.md`.
 *
 * Wrapped in its own try/catch rather than sharing `main`'s. Contention is the newer and more
 * expensive of the two queries, and a failure here must cost the notice, never the recap that
 * was already computed.
 */
function contentionNotice(worktreeRoot: string): { readonly text: string; readonly files: number } | null {
  try {
    const overlaps = findOverlappingWork({
      worktreeRoot,
      ledgerPath: ledgerPathFor(worktreeRoot),
      withinMinutes: CONTENTION_WITHIN_MINUTES,
      limit: CONTENTION_LIMIT,
    });
    // The common case, and the reason this is affordable: nothing is said unless something is
    // actually contested. `renderOverlap`'s empty answers are useful when a person asked a
    // question; nobody asked this one.
    if (overlaps.overlaps.length === 0) return null;
    return {
      text: renderOverlap(overlaps, undefined),
      files: overlaps.overlaps.length,
    };
  } catch (error) {
    debug(error instanceof Error ? error.message : "unknown contention failure");
    return null;
  }
}

export async function main(): Promise<number> {
  try {
    const raw = await readStdin();
    const payload: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
    const cwd = isRecord(payload) && typeof payload["cwd"] === "string" ? payload["cwd"] : process.cwd();
    const worktreeRoot = findWorktreeRoot(cwd);
    if (worktreeRoot === null) {
      debug("no git worktree found for hook cwd");
      return 0;
    }

    const result = recapRecentWork({
      worktreeRoot,
      ledgerPath: ledgerPathFor(worktreeRoot),
      withinMinutes: RECAP_WITHIN_MINUTES,
      limit: RECAP_LIMIT,
    });
    // Nothing recorded yet is the common case on a fresh install. Injecting "no recent work"
    // into every session would be pure cost for no answer, so say nothing at all.
    if (result.tasks.length === 0) {
      debug("no recent work to report");
      return 0;
    }

    const contention = contentionNotice(worktreeRoot);
    const context = withinBudget(asAdditionalContext(renderRecap(result, undefined), contention?.text));

    // Measured on the same terms as every other answer, so answers-per-session stops being
    // an assumption. This is the number PM-01 exists to move and PM-10 needs a sample of.
    recordAnswer(measurementPathFor(worktreeRoot, LEDGER_DIRECTORY), {
      tool: "session_start_recap",
      answerBytes: Buffer.byteLength(context, "utf8"),
      items: result.tasks.length + (contention?.files ?? 0),
      withheld: result.truncated,
    });

    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    })}\n`);
    return 0;
  } catch (error) {
    // Same contract as the recorder: a read-side hook must never be able to fail a session.
    debug(error instanceof Error ? error.message : "unknown recap failure");
    return 0;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
