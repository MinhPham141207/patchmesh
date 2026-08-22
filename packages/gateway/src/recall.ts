import type { ProtocolEvent } from "@patchmesh/protocol";
import {
  logicalPathFor,
  readInFlightCalls,
  resolveRepositoryIdentity,
  resourceIdForPath,
  type InFlightCall,
} from "@patchmesh/recorder";
import { SqliteEventStore } from "@patchmesh/storage";

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

const CAVEAT =
  "\nThis is a record of what happened, not a judgement. Same file does not mean same work.";

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
    };
  }

  const store = SqliteEventStore.open(options.ledgerPath);
  let events: readonly ProtocolEvent[];
  try {
    events = store.read();
  } finally {
    store.close();
  }

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
  };
}

/** Render a recall result as the compact text an agent reads inline. */
export function renderRecall(result: RecallResult, requestedPath: string | undefined): string {
  const scope =
    result.logicalPath !== null
      ? `\`${result.logicalPath}\``
      : requestedPath !== undefined && requestedPath.trim() !== ""
        ? `\`${requestedPath}\` (outside this repository, so nothing is recorded for it)`
        : "this repository";

  const inFlightLines = result.inFlight.map((call) => {
    const seconds = Math.round(call.runningForMs / 1000);
    const what = call.operation === null ? call.hostToolName : `${call.hostToolName}: ${call.operation}`;
    return `- ${call.agentId ?? "unattributed"} ${what} (running ${seconds}s)`;
  });
  // Deliberately first: work still in flight decides more than work already finished.
  const inFlightSection =
    result.inFlight.length === 0
      ? ""
      : `${result.inFlight.length} call(s) running right now:${NEWLINE}${inFlightLines.join(NEWLINE)}${NEWLINE}${NEWLINE}`;

  const changeLines = result.changes.map((change) => {
    const who = change.agentId ?? "unattributed";
    const task = change.taskId === null ? "no task" : change.taskId;
    return `- ${change.at} ${who} (${task}) ${change.changeKind} ${change.logicalPath}`;
  });
  const changeSection =
    result.changes.length === 0
      ? ""
      : `\n\n${result.changes.length} observed file change(s), most recent first:\n${changeLines.join("\n")}` +
        (result.truncatedChanges > 0 ? `\n(${result.truncatedChanges} older change(s) not shown.)` : "");

  if (result.calls.length === 0) {
    // A file written by a shell command is named by no tool argument, so changes can be the
    // only thing that answers a file-scoped question.
    if (result.changes.length > 0) {
      return `${inFlightSection}No recorded tool call named ${scope}, but the filesystem shows it changed.${changeSection}${CAVEAT}`;
    }
    if (result.inFlight.length > 0) return `${inFlightSection}No completed activity recorded for ${scope}.${CAVEAT}`;
    return `No recorded agent activity for ${scope}.`;
  }

  const lines = result.calls.map((call) => {
    const task = call.taskId === null ? "no task" : call.taskId;
    const outcome = call.outcome === "failed" ? " [failed]" : "";
    return `- ${call.at} ${call.agentId} (${task}) ${call.toolName}: ${call.operation}${outcome}`;
  });

  const header = `${result.calls.length} recorded call(s) for ${scope}, across ${result.agents.length} agent(s), most recent first:`;
  const footer =
    result.truncated > 0 ? `\n(${result.truncated} older matching call(s) not shown.)` : "";
  return `${inFlightSection}${header}\n${lines.join("\n")}${footer}${changeSection}${CAVEAT}`;
}
