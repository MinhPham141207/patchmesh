import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * What each session has already been told, so the same context is not injected twice in a row.
 *
 * The `SessionStart` hook fired 82 times across this repository and produced 16 distinct
 * payloads. 45 of the 81 gaps between fires were under a minute and the shortest was 0.46
 * seconds: bursts of the same text, delivered to a session that already had it. Every one of
 * those also incremented the answer count that PM-01 is measured by, so the evidence that the
 * hook works was mostly the hook repeating itself.
 *
 * The rule is deliberately narrow. Suppressing *all* repeats would be wrong -- a `compact` or
 * a `resume` an hour later is exactly the moment an agent has lost its context and most needs
 * it back, even if nothing in the repository changed meanwhile. What is never useful is the
 * same bytes arriving seconds after they already did. So this suppresses a repeat only when
 * the digest matches AND it lands inside a short window. See docs/problems/PM-14.
 */

const STATE_FILENAME = "session-start.json";
const STATE_VERSION = 1;

/**
 * How close together two identical injections have to be before the second is noise.
 *
 * Long enough to swallow a burst of hook fires for one host event, short enough that a genuine
 * re-orientation after a compact is never suppressed.
 */
export const REPEAT_SUPPRESSION_MS = 5 * 60_000;

/**
 * Sessions to remember. A host that opens many sessions should not grow this file forever, and
 * forgetting an old session costs one duplicate injection, which is what the file exists to
 * avoid rather than something it must guarantee.
 */
const MAX_SESSIONS = 32;

interface InjectionRecord {
  readonly digest: string;
  readonly at: string;
}

interface InjectionState {
  readonly v: number;
  readonly sessions: Record<string, InjectionRecord>;
}

export function injectionStatePathFor(worktreeRoot: string, directory: string): string {
  return join(worktreeRoot, directory, STATE_FILENAME);
}

/** Content identity, so "the same context" means the same bytes rather than the same window. */
export function digestOf(context: string): string {
  return createHash("sha256").update(context, "utf8").digest("hex").slice(0, 16);
}

function readState(statePath: string): InjectionState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (
      typeof parsed === "object"
      && parsed !== null
      && (parsed as InjectionState).v === STATE_VERSION
      && typeof (parsed as InjectionState).sessions === "object"
      && (parsed as InjectionState).sessions !== null
    ) {
      return parsed as InjectionState;
    }
  } catch {
    // No file, unreadable file, or a version this build does not know: all mean "nothing has
    // been injected", which costs at most one duplicate.
  }
  return { v: STATE_VERSION, sessions: {} };
}

/**
 * Decide whether this context is worth injecting, and remember it when it is.
 *
 * Returns `true` when the caller should inject. Writing is best effort for the same reason the
 * measurement file is: a hook that runs before the user's first prompt must never fail, and
 * failing to remember an injection is not a reason to withhold one.
 */
export function claimInjection(
  statePath: string,
  sessionId: string | null,
  context: string,
  now: Date = new Date(),
  suppressWithinMs: number = REPEAT_SUPPRESSION_MS,
): boolean {
  // Without a session id there is nothing to compare against. A host that does not declare
  // its session gets the context every time, which is the old behaviour.
  if (sessionId === null || sessionId === "") return true;

  const digest = digestOf(context);
  const state = readState(statePath);
  const previous = state.sessions[sessionId];
  if (previous !== undefined && previous.digest === digest) {
    const elapsed = now.getTime() - Date.parse(previous.at);
    // `NaN` from an unparseable stored timestamp fails this comparison and injects, which is
    // the safe direction: a duplicate costs context, a suppressed first injection costs the
    // whole point of the hook.
    if (elapsed >= 0 && elapsed < suppressWithinMs) return false;
  }

  const sessions: Record<string, InjectionRecord> = {
    ...state.sessions,
    [sessionId]: { digest, at: now.toISOString() },
  };
  const ordered = Object.entries(sessions).sort(
    ([, left], [, right]) => Date.parse(right.at) - Date.parse(left.at),
  );
  const kept = Object.fromEntries(ordered.slice(0, MAX_SESSIONS));

  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ v: STATE_VERSION, sessions: kept })}\n`, "utf8");
  } catch {
    // Never surfaces.
  }
  return true;
}
