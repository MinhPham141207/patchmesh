import type { ProtocolEvent } from "patchmesh-protocol";
import { SqliteEventStore } from "patchmesh-storage";

/**
 * How long an agent works before it changes anything: the cost of resuming.
 *
 * This is the one value claim PatchMesh can make without estimating a counterfactual. The
 * displacement measure it replaces asks what an agent *would* have read, which nobody
 * observed; this asks only what the agent actually did, which the ledger already holds on
 * both sides.
 *
 * The measure is calls before the first `file.changed` attributed to that agent. Everything
 * before that first change is orientation - reading, searching, working out where the last
 * session stopped - and orientation is exactly what a recap displaces. A session that
 * changes nothing has no resume point and is reported separately rather than counted as
 * zero, because "never resumed" and "resumed immediately" are opposite results.
 *
 * IMPORTANT, and the reason this exists as a command rather than a scratch query: the
 * baseline is destroyed by the fix. Once a `SessionStart` hook injects a recap into every
 * session, no un-instrumented session is ever recorded again. The number has to be captured
 * and frozen before that lands. See `docs/measurements/time-to-resume.md`.
 */
export interface AgentResumeMeasurement {
  readonly agentId: string;
  /** Calls this agent made before its first observed change. Null when it never changed anything. */
  readonly callsBeforeFirstChange: number | null;
  readonly firstEventAt: string;
  /** When the agent first changed a file, or null if it never did. */
  readonly firstChangeAt: string | null;
  readonly totalCalls: number;
}

export interface ResumeMetrics {
  /** One row per agent that made at least one call, longest resume first. */
  readonly agents: readonly AgentResumeMeasurement[];
  /** Median of `callsBeforeFirstChange` across agents that reached a change. Null when none did. */
  readonly medianCalls: number | null;
  /** How many agents reached a first change, which is the sample the median rests on. */
  readonly measuredAgents: number;
  /** Agents that called tools but never changed a file; excluded from the median deliberately. */
  readonly agentsWithoutChange: number;
  readonly eventCount: number;
  /** Bounds of the measured window, so a frozen baseline says what it was measured over. */
  readonly firstEventAt: string | null;
  readonly lastEventAt: string | null;
}

export interface ResumeMetricsOptions {
  readonly ledgerPath: string;
  /** Narrow to one agent. Omitted means every agent that worked here. */
  readonly agent?: string | undefined;
  /**
   * Count subagents as their own agents rather than folding them into a parent.
   *
   * Off by default: a subagent is spawned to do one thing and starts changing files almost
   * immediately, so counting them drags the median toward zero and flatters the baseline.
   * The measure is about resuming a session, and a subagent does not resume anything.
   */
  readonly includeSubagents?: boolean | undefined;
}

interface Accumulator {
  firstEventAt: string;
  lastEventAt: string;
  calls: number;
  callsBeforeFirstChange: number | null;
  firstChangeAt: string | null;
}

/** A subagent carries its parent in its id, which is the only place the relationship exists. */
function isSubagent(agentId: string): boolean {
  return agentId.includes(".sub.");
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  // An even-length sample has no single middle member. Averaging the two keeps the value
  // comparable across runs as the sample grows, which a "lower middle" convention does not.
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function measureTimeToResume(options: ResumeMetricsOptions): ResumeMetrics {
  const store = SqliteEventStore.open(options.ledgerPath);
  let events: readonly ProtocolEvent[];
  try {
    events = store.read({ eventTypes: ["tool.requested", "file.changed"] });
  } finally {
    store.close();
  }

  const byAgent = new Map<string, Accumulator>();
  let firstEventAt: string | null = null;
  let lastEventAt: string | null = null;

  for (const event of events) {
    if (firstEventAt === null || event.timestamp < firstEventAt) firstEventAt = event.timestamp;
    if (lastEventAt === null || event.timestamp > lastEventAt) lastEventAt = event.timestamp;

    const agentId = event.agentId;
    // An unattributed event belongs to no session, so it cannot say when a session resumed.
    // Counting it against some agent would be the laundering PM-09 explicitly rejects.
    if (agentId === null) continue;
    if (options.agent !== undefined && agentId !== options.agent) continue;
    if (options.includeSubagents !== true && isSubagent(agentId)) continue;

    const accumulator = byAgent.get(agentId) ?? {
      firstEventAt: event.timestamp,
      lastEventAt: event.timestamp,
      calls: 0,
      callsBeforeFirstChange: null,
      firstChangeAt: null,
    };
    if (event.timestamp < accumulator.firstEventAt) accumulator.firstEventAt = event.timestamp;
    if (event.timestamp > accumulator.lastEventAt) accumulator.lastEventAt = event.timestamp;

    if (event.eventType === "tool.requested") {
      accumulator.calls += 1;
    } else if (accumulator.firstChangeAt === null) {
      // The first change closes the orientation window. `calls` is read before this event is
      // itself counted, so the number is calls made *before* anything changed.
      accumulator.firstChangeAt = event.timestamp;
      accumulator.callsBeforeFirstChange = accumulator.calls;
    }
    byAgent.set(agentId, accumulator);
  }

  const agents: AgentResumeMeasurement[] = [...byAgent.entries()]
    .map(([agentId, accumulator]) => ({
      agentId,
      callsBeforeFirstChange: accumulator.callsBeforeFirstChange,
      firstEventAt: accumulator.firstEventAt,
      firstChangeAt: accumulator.firstChangeAt,
      totalCalls: accumulator.calls,
    }))
    // Longest resume first: the tail is the interesting half, and a list that leads with the
    // agents that resumed instantly reads as though the problem is smaller than it is.
    .sort((left, right) =>
      (right.callsBeforeFirstChange ?? -1) - (left.callsBeforeFirstChange ?? -1)
      || (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0));

  const measured = agents
    .map((agent) => agent.callsBeforeFirstChange)
    .filter((value): value is number => value !== null);

  return {
    agents,
    medianCalls: median(measured),
    measuredAgents: measured.length,
    agentsWithoutChange: agents.length - measured.length,
    eventCount: events.length,
    firstEventAt,
    lastEventAt,
  };
}

export function renderResumeMetrics(metrics: ResumeMetrics): string {
  if (metrics.agents.length === 0) {
    return "No agent activity recorded, so there is no time-to-resume to measure.";
  }
  const lines = [
    "Time to resume - calls before an agent's first observed change",
    "",
    `Median:            ${metrics.medianCalls ?? "n/a"} call(s)`,
    `Agents measured:   ${metrics.measuredAgents}`,
    `Never changed:     ${metrics.agentsWithoutChange}`,
    `Events read:       ${metrics.eventCount}`,
    `Window:            ${metrics.firstEventAt ?? "n/a"} to ${metrics.lastEventAt ?? "n/a"}`,
    "",
  ];
  for (const agent of metrics.agents) {
    const value = agent.callsBeforeFirstChange === null
      ? `never changed a file (${agent.totalCalls} call(s))`
      : `${agent.callsBeforeFirstChange} call(s) before ${agent.firstChangeAt}`;
    lines.push(`  ${agent.agentId}  ${value}`);
  }
  lines.push("");
  lines.push(
    "Orientation is the half a recap displaces. This number is only a baseline while no",
    "session is given one - once SessionStart injects context, it measures the treatment.",
  );
  return lines.join("\n");
}
