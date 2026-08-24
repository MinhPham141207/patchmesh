import type { ProtocolEvent } from "patchmesh-protocol";
import {
  logicalPathFor,
  readInFlightCalls,
  resolveRepositoryIdentity,
  resourceIdForPath,
  type InFlightCall,
} from "patchmesh-recorder";
import { readWindowCached } from "patchmesh-storage";
import { describeWindow, idShortener } from "patchmesh-query";

/** One recorded call, reduced to what another agent needs in order to decide something. */
export interface RecalledCall {
  readonly at: string;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly toolName: string;
  readonly operation: string;
  readonly logicalPath: string | null;
  readonly outcome: "succeeded" | "failed" | "interrupted" | null;
}

/**
 * One observed change to a file, which is a different claim from a call.
 *
 * A call is what an agent asked for; a change is what the filesystem shows. They are recorded
 * separately and joined only by the turn they share, because the recorder observes the
 * worktree between turns rather than per call - see `recordTurnEffects`.
 */
export interface RecalledChange {
  readonly at: string;
  readonly agentId: string | null;
  readonly taskId: string | null;
  readonly logicalPath: string;
  readonly changeKind: string;
}

export interface RecallOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  /** Repository-relative or absolute path to narrow to. Omitted means the whole repository. */
  readonly path?: string | undefined;
  readonly withinMinutes?: number | undefined;
  readonly limit?: number | undefined;
  /** Exclude this agent's own calls, so a caller does not rediscover its own work. */
  readonly excludeAgentId?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface RecallResult {
  readonly calls: readonly RecalledCall[];
  /**
   * Calls that have started and not reported back, read live from the journal.
   *
   * The ledger cannot answer this: ingest runs on Stop, so anything it holds has finished.
   */
  readonly inFlight: readonly InFlightCall[];
  /** Observed file changes in the same window. Empty until a turn has been observed. */
  readonly changes: readonly RecalledChange[];
  /** Changes that matched but were not returned. */
  readonly truncatedChanges: number;
  /** Calls that matched but were not returned, so a caller can tell a page from the whole truth. */
  readonly truncated: number;
  readonly logicalPath: string | null;
  readonly agents: readonly string[];
  /** The window this answer covers, in minutes, so the answer can say what it looked at. */
  readonly withinMinutes: number;
}

/**
 * A recall answer is capped hard.
 *
 * PatchMesh only pays for itself if the context it hands back is smaller than the discovery
 * it displaces. An unbounded event dump costs an agent more than reading the file would have,
 * which makes the tool a net loss no matter how accurate it is.
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_WITHIN_MINUTES = 240;

/**
 * Stated on every answer: the ledger records which file was touched and whether its contents
 * differ, never what the difference means. Two agents changing one file may be collaborating.
 */
const NEWLINE = "\n";

/**
 * The standing "this reports, it does not judge" caveat moved into the MCP tool description,
 * which a session pays for once rather than once per answer. What remains is the part that is
 * about these rows rather than about the tool.
 */
const CAVEAT = "\nSame file does not mean same work.";

function payloadOf(event: ProtocolEvent): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
}

/**
 * Report what agents recently did in this repository, optionally narrowed to one file.
 *
 * This reports; it does not judge. Two agents touching one file may or may not be a
 * collision, and the ledger records paths rather than the content of a change, so deciding
 * that is the caller's job. Saying "here is who touched this and when" is answerable from
 * what is recorded; "you are duplicating work" is not.
 */
export function recallRecentActivity(options: RecallOptions): RecallResult {
  const identity = resolveRepositoryIdentity(options.worktreeRoot);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const withinMinutes = Math.max(options.withinMinutes ?? DEFAULT_WITHIN_MINUTES, 1);
  const now = (options.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - withinMinutes * 60_000);

  const pathRequested = options.path !== undefined && options.path.trim() !== "";
  const requestedPath = pathRequested ? logicalPathFor(identity.worktreeRoot, options.path!) : null;
  const targetResourceId =
    requestedPath === null ? null : resourceIdForPath(identity.repositoryId, requestedPath);

  // A path that cannot be expressed in this repository must answer for nothing, not for
  // everything. Silently widening "what happened to this file" into "what happened anywhere"
  // would hand back an answer to a question the caller did not ask.
  if (pathRequested && requestedPath === null) {
    return {
      calls: [],
      changes: [],
      inFlight: [],
      truncated: 0,
      truncatedChanges: 0,
      logicalPath: null,
      agents: [],
      withinMinutes,
    };
  }

  // Unchecked and cached, as an advisory read: see `reconstructStoredEvent`.
  const events = readWindowCached(
    options.ledgerPath,
    {
      eventTypes: ["tool.requested", "tool.completed", "file.changed"],
      since: since.toISOString(),
    },
    { validate: false },
  );

  // A completion carries the outcome but not the operation, so requests are the spine and
  // each one picks up its own completion by causation.
  const outcomeByRequestId = new Map<string, string>();
  for (const event of events) {
    if (event.eventType !== "tool.completed") continue;
    const payload = payloadOf(event);
    const requestEventId = payload["requestEventId"];
    if (typeof requestEventId === "string" && typeof payload["outcome"] === "string") {
      outcomeByRequestId.set(requestEventId, payload["outcome"]);
    }
  }

  // Observed changes answer the question calls cannot: a file written by a shell command is
  // named by no tool argument, so before effects were observed a file-scoped query returned
  // nothing for work that had plainly happened.
  const matchedChanges: RecalledChange[] = [];
  for (const event of events) {
    if (event.eventType !== "file.changed") continue;
    if (new Date(event.timestamp) < since) continue;
    if (options.excludeAgentId !== undefined && event.agentId === options.excludeAgentId) continue;
    const resource = payloadOf(event)["resource"] as { resourceId?: unknown; locator?: unknown } | undefined;
    if (targetResourceId !== null && resource?.resourceId !== targetResourceId) continue;
    matchedChanges.push({
      at: event.timestamp,
      agentId: event.agentId,
      taskId: event.taskId,
      logicalPath: String(resource?.locator ?? ""),
      changeKind: String(payloadOf(event)["changeKind"] ?? "changed"),
    });
  }
  matchedChanges.sort((left, right) => right.at.localeCompare(left.at));
  const changes = matchedChanges.slice(0, limit);

  const matched: RecalledCall[] = [];
  for (const event of events) {
    if (event.eventType !== "tool.requested") continue;
    if (new Date(event.timestamp) < since) continue;
    if (event.agentId === null) continue;
    if (options.excludeAgentId !== undefined && event.agentId === options.excludeAgentId) continue;

    const payload = payloadOf(event);
    if (targetResourceId !== null && payload["targetResourceId"] !== targetResourceId) continue;

    const outcome = outcomeByRequestId.get(event.eventId);
    matched.push({
      at: event.timestamp,
      agentId: event.agentId,
      taskId: event.taskId,
      toolName: String(payload["toolName"]),
      operation: String(payload["operation"]),
      logicalPath: requestedPath,
      outcome: outcome === undefined ? null : (outcome as RecalledCall["outcome"]),
    });
  }

  // Most recent first: what happened a minute ago decides more than what happened an hour ago.
  matched.sort((left, right) => right.at.localeCompare(left.at));
  const calls = matched.slice(0, limit);

  // Read live rather than from the ledger, and never fatal: an unreadable journal means the
  // in-flight view is empty, not that the answer failed.
  let inFlight: readonly InFlightCall[] = [];
  try {
    inFlight = readInFlightCalls({
      worktreeRoot: options.worktreeRoot,
      now: () => now,
      excludeAgentId: options.excludeAgentId,
    });
  } catch {
    inFlight = [];
  }

  return {
    calls,
    changes,
    inFlight,
    truncated: matched.length - calls.length,
    truncatedChanges: matchedChanges.length - changes.length,
    logicalPath: requestedPath,
    agents: [...new Set(calls.map((call) => call.agentId))],
    withinMinutes,
  };
}

/**
 * One line, bounded, for a command that may be a whole script.
 *
 * An in-flight entry is read straight from the journal, so its operation is whatever the host
 * passed - a heredoc or an inlined program arrives with its newlines intact and turns a
 * one-line status report into a page of someone else's source. What a caller needs from a
 * running call is which tool and roughly what, not the text of it.
 */
const OPERATION_LIMIT = 120;

function summarizeOperation(operation: string): string {
  const firstLine = operation.split("\n", 1)[0] ?? "";
  const collapsed = firstLine.trim();
  const suffix = collapsed.length < operation.trim().length ? " …" : "";
  return collapsed.length > OPERATION_LIMIT
    ? `${collapsed.slice(0, OPERATION_LIMIT)} …`
    : `${collapsed}${suffix}`;
}

/**
 * Group observed changes by the worker and task that made them.
 *
 * One line per change repeated the same timestamp, agent, and task for every file in a turn:
 * on this repository's ledger, fifteen changes rendered as fifteen ~110-character lines whose
 * informative half was the fifteen paths. The worker is the thing a caller is deciding about,
 * so it is said once and the files are listed under it.
 */
function renderChanges(result: RecallResult, short: (id: string) => string): string {
  const groups = new Map<string, { agentId: string; taskId: string | null; at: string; byKind: Map<string, string[]> }>();
  for (const change of result.changes) {
    const agentId = change.agentId ?? "unattributed";
    const key = `${agentId} ${change.taskId ?? ""}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { agentId, taskId: change.taskId, at: change.at, byKind: new Map() };
      groups.set(key, group);
    }
    // Changes arrive newest first, so the first timestamp seen is the group's most recent.
    const paths = group.byKind.get(change.changeKind);
    if (paths === undefined) group.byKind.set(change.changeKind, [change.logicalPath]);
    else paths.push(change.logicalPath);
  }

  const workers = groups.size;
  const header = `${result.changes.length} file change(s) observed, by ${workers} worker(s), most recent first:`;
  const lines: string[] = [header];
  for (const group of groups.values()) {
    const task = group.taskId === null ? "no task" : short(group.taskId);
    lines.push(`- ${short(group.agentId)} (${task}) at ${group.at}`);
    for (const [changeKind, paths] of group.byKind) lines.push(`  ${changeKind}: ${paths.join(", ")}`);
  }
  if (result.truncatedChanges > 0) lines.push(`(${result.truncatedChanges} older change(s) not shown.)`);
  return lines.join(NEWLINE);
}

/**
 * Summarize calls the caller did not ask about, and list the ones it did.
 *
 * 79% of recorded calls are shell commands, stored as a redacted command string that names no
 * resource. Listing twenty of them spends a caller's context on `git add` and `git status` and
 * returns nothing it can act on, which is the net-token invariant failing in the direction
 * that costs rather than saves.
 *
 * Detail follows the question. A caller that narrowed to a file gets every call that named it,
 * because that is the answer it asked for. A caller asking about the whole repository gets a
 * count, plus any call that failed - a failure is the one thing in an unnarrowed stream that a
 * reader could not have predicted.
 */
function renderCalls(result: RecallResult, scope: string, short: (id: string) => string): string {
  const pathScoped = result.logicalPath !== null;
  const line = (call: RecalledCall) => {
    const task = call.taskId === null ? "no task" : short(call.taskId);
    const outcome = call.outcome === "failed" ? " [failed]" : "";
    return `- ${call.at} ${short(call.agentId)} (${task}) ${call.toolName}: ${call.operation}${outcome}`;
  };

  if (pathScoped) {
    const header = `${result.calls.length} recorded call(s) for ${scope} in the last ${describeWindow(result.withinMinutes)}, across ${result.agents.length} agent(s), most recent first:`;
    const footer = result.truncated > 0 ? `${NEWLINE}(${result.truncated} older matching call(s) not shown.)` : "";
    return `${header}${NEWLINE}${result.calls.map(line).join(NEWLINE)}${footer}`;
  }

  // No tool histogram. 79% of recorded calls are shell commands stored as a redacted string,
  // so the histogram said "mostly run_shell" in every window -- a property of what the recorder
  // can see rather than of this answer, and nothing a reader can act on. The count and the
  // failures are what remain: a failure is the one thing in an unnarrowed stream that could not
  // have been predicted.
  const total = result.calls.length + result.truncated;
  const lines = [
    `${total} call(s) recorded across ${result.agents.length} agent(s) in the last ${describeWindow(result.withinMinutes)}.`,
  ];
  const failures = result.calls.filter((call) => call.outcome === "failed");
  if (failures.length > 0) {
    lines.push(`${failures.length} failed:`, ...failures.map(line));
  }
  lines.push("Ask about a specific path to see the calls that named it.");
  return lines.join(NEWLINE);
}

/** Render a recall result as the compact text an agent reads inline. */
export function renderRecall(result: RecallResult, requestedPath: string | undefined): string {
  const scope =
    result.logicalPath !== null
      ? `\`${result.logicalPath}\``
      : requestedPath !== undefined && requestedPath.trim() !== ""
        ? `\`${requestedPath}\` (outside this repository, so nothing is recorded for it)`
        : "this repository";

  // See `shortIds`: one table for the whole answer, because ids are only ever compared with
  // the ones printed beside them.
  const short = idShortener([
    ...result.calls.flatMap((call) => (call.taskId === null ? [call.agentId] : [call.agentId, call.taskId])),
    ...result.changes.flatMap((change) => [
      ...(change.agentId === null ? [] : [change.agentId]),
      ...(change.taskId === null ? [] : [change.taskId]),
    ]),
    ...result.inFlight.flatMap((call) => (call.agentId === null ? [] : [call.agentId])),
  ]);

  const inFlightLines = result.inFlight.map((call) => {
    const seconds = Math.round(call.runningForMs / 1000);
    const what = call.operation === null ? call.hostToolName : `${call.hostToolName}: ${summarizeOperation(call.operation)}`;
    return `- ${call.agentId === null ? "unattributed" : short(call.agentId)} ${what} (running ${seconds}s)`;
  });
  // Deliberately first: work still in flight decides more than work already finished.
  const inFlightSection =
    result.inFlight.length === 0
      ? ""
      : `${result.inFlight.length} call(s) running right now:${NEWLINE}${inFlightLines.join(NEWLINE)}${NEWLINE}${NEWLINE}`;

  const changes = result.changes.length === 0 ? null : renderChanges(result, short);

  if (result.calls.length === 0) {
    // A file written by a shell command is named by no tool argument, so changes can be the
    // only thing that answers a file-scoped question.
    if (changes !== null) {
      return `${inFlightSection}No recorded tool call named ${scope}, but the filesystem shows it changed.${NEWLINE}${NEWLINE}${changes}${CAVEAT}`;
    }
    if (result.inFlight.length > 0) return `${inFlightSection}No completed activity recorded for ${scope}.${CAVEAT}`;
    return `No recorded agent activity for ${scope}.`;
  }

  // Effects before calls. A call is what an agent asked for and a change is what the
  // filesystem shows; the second is the one a caller can act on, and leading with the first
  // buried it under whatever shell plumbing happened to run in the window.
  const changesFirst = changes === null ? "" : `${changes}${NEWLINE}${NEWLINE}`;
  return `${inFlightSection}${changesFirst}${renderCalls(result, scope, short)}${CAVEAT}`;
}
