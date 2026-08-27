#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  computeContentionAdvisory,
  computePostWriteAdvisory,
  computeTurnStartAdvisory,
  type DeliveredFact,
} from "./advisory.js";
import { findWorktreeRoot } from "./identity.js";
import { appendJournalEntry, journalPathFor } from "./journal.js";
import { redactHookPayload } from "./redact.js";
import { advanceWatermark } from "./recent-writes.js";
import { claudeCodeAdapter, isKnownHost, opencodeAdapter, translateOpencodeRecord } from "./hosts/index.js";

/**
 * Hook entry point, on the agent's critical path.
 *
 * It imports only `./advisory.js`, `./identity.js`, `./journal.js`, `./redact.js`, and
 * `./hosts/index.js`, none of which pull anything beyond Node builtins and each other.
 * Importing `patchmesh-protocol` or `patchmesh-storage` here would add roughly 400ms of Ajv
 * import and schema compilation to every single tool call; that work belongs in
 * `patchmesh-ingest`, which pays it once. Keep this module's import graph flat.
 */

const LEDGER_DIRECTORY = ".patchmesh";
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * The provenance for this invocation: the `--host <id>` the plugin passes, when it passes
 * one. An unknown value is a wiring mistake that would otherwise stamp every call with a
 * source id no query could group on, so nothing is recorded and the process still exits 0 -
 * the same always-exit-0 discipline as every other failure here, discoverable under
 * PATCHMESH_RECORDER_DEBUG.
 */
function requestedHost(argv: readonly string[]): string | null {
  let host: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--host requires a value");
      host = value;
      index += 1;
    } else if (argument !== undefined && argument.startsWith("--host=")) {
      host = argument.slice("--host=".length);
    } else {
      throw new Error(`unsupported argument: ${String(argument)}`);
    }
  }
  return host;
}

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
    process.stderr.write(`patchmesh-record: ${message}\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PM-02 option A: warn -- never block -- when a different agent has a call in flight on the
 * same `Edit`/`Write` path. This has its own try/catch, separate from the journal append in
 * `main`, so a failure here can only cost the advisory, never the recording that already
 * happened above it: the same founding discipline that keeps this whole binary always
 * exiting 0. `compute` is a parameter so a test can force a failure without needing a real
 * one, since `computeContentionAdvisory`'s own dependencies are already fail-open by design.
 *
 * Emission stops at `permissionDecision: "allow"` with a reason -- confirmed non-blocking by
 * the host's own hook contract, since `"allow"` bypasses the permission system outright. What
 * is *not* confirmed is whether that reason reaches Claude's own context on `PreToolUse`
 * rather than only the user's transcript; the host's documented channels for reaching the
 * model on this event are `deny` and `ask`, and both block, which PM-02 rules out until this
 * advisory has a measured false-positive rate. That is left as an open question rather than
 * guessed at -- see docs/problems/PM-02-no-intervention-point.md.
 */
export function emitAdvisory(
  worktreeRoot: string,
  payload: Record<string, unknown>,
  compute: typeof computeContentionAdvisory = computeContentionAdvisory,
): void {
  try {
    const advisory = compute({ worktreeRoot, payload });
    if (advisory === null) return;
    debug(`contention: ${advisory.message}`);
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: advisory.message,
        },
      })}\n`,
    );
    advanceDeliveredFact(advisory);
  } catch (error) {
    debug(error instanceof Error ? `advisory failed: ${error.message}` : "unknown advisory failure");
  }
}

/**
 * Move the session's delivery cursor past a fact that just reached stdout. Only after the
 * write: if emission fails, the message is lost but the channel is not -- the next look
 * re-delivers. A cursor failure costs nothing on its own.
 */
function advanceDeliveredFact(advisory: { readonly delivery?: DeliveredFact | undefined }): void {
  if (advisory.delivery === undefined) return;
  try { advanceWatermark(advisory.delivery.cursorPath, advisory.delivery.advanceTo); } catch { /* advisory-only */ }
}

/**
 * PM-02 option A, delivered: the same contention check as `emitAdvisory`, run one hook later
 * on `PostToolUse`, where `additionalContext` is documented as valid and delivered into the
 * current turn -- unlike `PreToolUse`'s `allow` reason, which the host only confirms reaches
 * the user's transcript. This is what actually warns the agent today, one call late instead
 * of before the write.
 *
 * Own try/catch, same reason as `emitAdvisory`: a failure here must cost only this advisory,
 * never the journal write `main` already made, and never `emitAdvisory`'s own attempt.
 *
 * No double warning of the agent even though both this and `emitAdvisory` run unconditionally
 * on every invocation: `computeContentionAdvisory` and `computePostWriteAdvisory` each gate on
 * their own `hook_event_name`, so at most one of them returns non-null for any single
 * invocation (a hook firing is either a `PreToolUse` call or a `PostToolUse` call, never
 * both) -- and even on the rare invocation where `emitAdvisory` also has something to say, its
 * output is not confirmed to reach the model at all, so this is the only one an agent actually
 * reads.
 */
export function emitPostWriteAdvisory(
  worktreeRoot: string,
  payload: Record<string, unknown>,
  compute: typeof computePostWriteAdvisory = computePostWriteAdvisory,
): void {
  try {
    const advisory = compute({ worktreeRoot, payload });
    if (advisory === null) return;
    debug(`post-write contention: ${advisory.message}`);
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: advisory.message,
        },
      })}\n`,
    );
    advanceDeliveredFact(advisory);
  } catch (error) {
    debug(error instanceof Error ? `post-write advisory failed: ${error.message}` : "unknown post-write advisory failure");
  }
}

/**
 * The turn-start stage: what other agents are already inside, before this turn has made a
 * single tool call.
 *
 * This is the one advisory that runs genuinely *before* a write, which is what PM-02 asks for
 * and what `PreToolUse` structurally cannot deliver. It needed no host configuration change:
 * `UserPromptSubmit` was already wired to this binary by `patchmesh init` as the turn boundary
 * that gives ordinary work a task, so the process was already spawning here and the advisory
 * is a decision inside an invocation that already happened.
 *
 * Own try/catch, for the same reason as the other two, and it cannot double-fire with them:
 * `computeTurnStartAdvisory` gates on `UserPromptSubmit`, which is neither of their stages.
 */
export function emitTurnStartAdvisory(
  worktreeRoot: string,
  payload: Record<string, unknown>,
  compute: typeof computeTurnStartAdvisory = computeTurnStartAdvisory,
): void {
  try {
    const advisory = compute({ worktreeRoot, payload });
    if (advisory === null) return;
    debug(`turn-start contention: ${advisory.paths.length} path(s)`);
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: advisory.message,
        },
      })}\n`,
    );
    advanceDeliveredFact(advisory);
  } catch (error) {
    debug(error instanceof Error ? `turn-start advisory failed: ${error.message}` : "unknown turn-start advisory failure");
  }
}

/**
 * Always exits 0. This process runs inside the user's tool-call path, so it must never be
 * able to fail the call it is observing: a recorder that can break the agent gets
 * uninstalled after one incident. Failures surface only under PATCHMESH_RECORDER_DEBUG.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    let hostFlag: string | null = null;
    try {
      hostFlag = requestedHost(argv);
    } catch (error) {
      debug(error instanceof Error ? error.message : "unknown argument failure");
      return 0;
    }
    if (hostFlag !== null && !isKnownHost(hostFlag)) {
      debug(`unsupported host: ${hostFlag} (known: claude-code, opencode, codex, generic-mcp)`);
      return 0;
    }

    const raw = await readStdin();
    if (raw.trim() === "") {
      debug("empty hook payload");
      return 0;
    }
    const payload: unknown = JSON.parse(raw);
    // A `stage: "before"` relay is OpenCode's pre-call notification. Recording one would
    // journal a full completion-shaped payload BEFORE the call has run, so every call would
    // be recorded twice once its after-relay landed too. The gate reads the raw parsed
    // object because redaction whitelists field names and strips `stage` before anything
    // downstream could see it. Nothing is journaled and the process still exits 0 - the same
    // always-exit-0 discipline as every other failure here.
    if (isRecord(payload) && payload["stage"] === "before") {
      debug("before-stage relay: nothing recorded");
      return 0;
    }
    const cwd = isRecord(payload) && typeof payload["cwd"] === "string" ? payload["cwd"] : process.cwd();
    const worktreeRoot = findWorktreeRoot(cwd);
    if (worktreeRoot === null) {
      debug("no git worktree found for hook cwd");
      return 0;
    }
    // A native OpenCode envelope is journaled as its Claude-shaped translation with the
    // provenance stamped on, whether or not `--host` was passed - the envelope's own shape
    // is evidence of where it came from, and the redactor only whitelists the translated
    // field names, so journaling the raw envelope would strip everything worth keeping.
    // Provenance rides on the payload (`patchmesh_host`) rather than this process's
    // environment because draining happens later, in a different process.
    const nativeOpencode =
      opencodeAdapter.parse(payload) !== null && claudeCodeAdapter.parse(payload) === null;
    const toJournal = nativeOpencode
      ? { ...translateOpencodeRecord(opencodeAdapter.parse(payload)!), patchmesh_host: "opencode" }
      : hostFlag !== null
        ? { ...(payload as Record<string, unknown>), patchmesh_host: hostFlag }
        : payload;
    // Redaction happens before the first disk write, not at ingest: anything written raw
    // has already leaked, and the journal is a plain file that survives until a session ends.
    const safe = redactHookPayload(toJournal);
    if (safe === null) {
      debug("hook payload was not an object");
      return 0;
    }
    appendJournalEntry(journalPathFor(worktreeRoot, LEDGER_DIRECTORY), safe, new Date().toISOString());
    debug(`journalled to ${join(worktreeRoot, LEDGER_DIRECTORY)}`);
    // Recording is the primary job and is already done above; the advisories are additive and
    // must never be able to take that back. All three are called unconditionally -- each gates
    // on its own hook_event_name, and the three stages are mutually exclusive for any single
    // invocation, so at most one of them ever writes output.
    emitAdvisory(worktreeRoot, safe);
    emitPostWriteAdvisory(worktreeRoot, safe);
    emitTurnStartAdvisory(worktreeRoot, safe);
    return 0;
  } catch (error) {
    debug(error instanceof Error ? error.message : "unknown recording failure");
    return 0;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
