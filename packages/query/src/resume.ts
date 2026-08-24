import { readEventsCached } from "patchmesh-storage";

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
  /**
   * The cohort this reading covers, echoed back so a frozen artifact states its own scope.
   *
   * A median with no cohort attached is not comparable to anything: the whole use of this
   * command now is comparing sessions that started before an intervention against sessions
   * that started after it.
   */
  readonly cohort: { readonly since: string | null; readonly until: string | null };
  /** Sessions excluded because they started outside the cohort, so a small `n` explains itself. */
  readonly excludedByCohort: number;
  /**
   * The before/after split, when a treatment boundary is known.
   *
   * Present so that the *default* output is the honest one. With no cohort flag this command
   * printed a single pooled median over both arms -- 84 against a frozen baseline of 83 --
   * which reads as "the intervention did nothing" when the truth is "the intervention has not
   * been measured yet". The split existed but was opt-in, so the reading anyone got for free
   * was the misleading one. See docs/problems/PM-10.
   */
  readonly arms?: TreatmentSplit | undefined;
}

/** One side of a before/after comparison, reported on its own terms. */
export interface ResumeArm {
  readonly medianCalls: number | null;
  readonly measuredAgents: number;
  readonly agentsWithoutChange: number;
}

export interface TreatmentSplit {
  /** When the treatment began. Sessions that started before it are control, at or after it treatment. */
  readonly boundary: string;
  readonly control: ResumeArm;
  readonly treatment: ResumeArm;
  /**
   * Whether the smaller arm carries enough sessions to support a comparison at all.
   *
   * Not a significance test -- it is a floor beneath which the command declines to be read as
   * a result. A median of one session is a session, not an effect.
   */
  readonly conclusive: boolean;
}

/**
 * Sessions an arm needs before its median is worth comparing.
 *
 * Deliberately a round, small, stated number rather than a test. The failure this guards
 * against is not a subtle statistical one; it is reading `n=1` as an answer.
 */
export const MIN_ARM_SAMPLE = 5;

export interface ResumeMetricsOptions {
  readonly ledgerPath: string;
  /** Narrow to one agent. Omitted means every agent that worked here. */
  readonly agent?: string | undefined;
  /**
   * Select a cohort of sessions by when each session **started**, not by event time.
   *
   * This distinction is the whole point of the flag, and getting it wrong makes the number
   * meaningless. A session is a single unit of orientation: it starts cold, works out where it
   * is, and eventually changes something. Filtering its *events* by time cuts that unit in half
   * and reports the remainder as though it were a whole session.
   *
   * It is not hypothetical. When `SessionStart` injection was installed here, exactly one
   * session was running, and it had begun five hours earlier. Splitting on event time would
   * have put its orientation in the control arm and its later work in the treatment arm, and
   * produced a treatment median from a session that was never treated. Splitting on session
   * start puts it wholly in the arm it belongs to.
   *
   * ISO timestamps, compared as strings against the session's first observed event.
   */
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  /**
   * Count subagents as their own agents rather than folding them into a parent.
   *
   * Off by default: a subagent is spawned to do one thing and starts changing files almost
   * immediately, so counting them drags the median toward zero and flatters the baseline.
   * The measure is about resuming a session, and a subagent does not resume anything.
   */
  readonly includeSubagents?: boolean | undefined;
  /**
   * When the intervention being measured began, so the reading splits itself without being asked.
   *
   * Supplied by the caller rather than discovered here: the boundary is the moment the
   * `SessionStart` hook first injected anything, which is recorded in the measurement file the
   * gateway writes, not in the ledger this module reads.
   */
  readonly treatmentSince?: string | undefined;
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
  // Unbounded rather than windowed, and therefore cacheable on its own terms: the metric is
  // about whole sessions, and a session that started before the window is not measurable from
  // inside it. No `since` also means the key is stable, so the repeated runs a cohort split
  // makes -- one for each arm -- read the ledger once between them.
  const events = readEventsCached(
    options.ledgerPath,
    { eventTypes: ["tool.requested", "file.changed"] },
    { validate: false },
  );

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

  // The cohort is applied here, after every event has been seen, because a session's start is
  // not known until its earliest event has been read. Filtering during the scan would need the
  // answer before it could be computed.
  const inCohort = (accumulator: Accumulator): boolean =>
    (options.since === undefined || accumulator.firstEventAt >= options.since)
    && (options.until === undefined || accumulator.firstEventAt <= options.until);
  const excludedByCohort = [...byAgent.values()].filter((accumulator) => !inCohort(accumulator)).length;

  const agents: AgentResumeMeasurement[] = [...byAgent.entries()]
    .filter(([, accumulator]) => inCohort(accumulator))
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
    cohort: { since: options.since ?? null, until: options.until ?? null },
    excludedByCohort,
    ...(options.treatmentSince === undefined
      ? {}
      : { arms: splitOnBoundary(byAgent, options.treatmentSince) }),
  };
}

/**
 * Split the accumulated sessions on the moment the treatment began.
 *
 * The boundary is compared against each session's **first event**, never against event time --
 * a session that started before the hook existed belongs wholly to the control arm however
 * long it goes on running. The comparison is exclusive on one side and inclusive on the other
 * so no session can be counted in both.
 */
function splitOnBoundary(byAgent: ReadonlyMap<string, Accumulator>, boundary: string): TreatmentSplit {
  const arm = (include: (accumulator: Accumulator) => boolean): ResumeArm => {
    const members = [...byAgent.values()].filter(include);
    const measured = members
      .map((member) => member.callsBeforeFirstChange)
      .filter((value): value is number => value !== null);
    return {
      medianCalls: median(measured),
      measuredAgents: measured.length,
      agentsWithoutChange: members.length - measured.length,
    };
  };
  const control = arm((accumulator) => accumulator.firstEventAt < boundary);
  const treatment = arm((accumulator) => accumulator.firstEventAt >= boundary);
  return {
    boundary,
    control,
    treatment,
    conclusive:
      control.measuredAgents >= MIN_ARM_SAMPLE && treatment.measuredAgents >= MIN_ARM_SAMPLE,
  };
}

/**
 * The moment the `SessionStart` hook first injected context, read from the measurement file.
 *
 * This is the only record of when the treatment began. The ledger cannot answer it: the
 * session-start binary only reads, so its fires leave no events behind -- they leave rows in
 * `answers.ndjson` and nowhere else. Returns null when nothing has ever been injected, which
 * means there is no treatment arm to split off yet.
 */
export function treatmentBoundaryFrom(answersContent: string): string | null {
  for (const line of answersContent.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row: unknown = JSON.parse(line);
      if (
        typeof row === "object"
        && row !== null
        && (row as { tool?: unknown }).tool === "session_start_recap"
        && typeof (row as { at?: unknown }).at === "string"
      ) {
        // The file is append-only and written in order, so the first matching row is the
        // earliest injection. Reading further would only find later ones.
        return (row as { at: string }).at;
      }
    } catch {
      // A truncated final line is normal for an append-only log; it is not a reason to fail.
    }
  }
  return null;
}

/**
 * The before/after block, including the sentence that stops it being over-read.
 *
 * The two medians are printed with their sample sizes attached, and when either arm is below
 * the floor the block says so in words instead of leaving the numbers to be compared anyway.
 * A reader who sees "83.5" and "191" side by side will compare them; the only defence is to
 * state, on the same screen, that one of them rests on a single session.
 */
function renderArms(arms: TreatmentSplit): readonly string[] {
  const describe = (label: string, arm: ResumeArm): string =>
    `  ${label.padEnd(10)} median ${String(arm.medianCalls ?? "n/a").padStart(6)} call(s)`
    + `   n=${arm.measuredAgents}, ${arm.agentsWithoutChange} never changed`;
  const lines = [
    `Sessions started before ${arms.boundary} are control; at or after it, treatment.`,
    "",
    describe("CONTROL", arms.control),
    describe("TREATMENT", arms.treatment),
    "",
  ];
  if (arms.conclusive) {
    lines.push(`Both arms carry at least ${MIN_ARM_SAMPLE} measured sessions, so the comparison can be read.`);
  } else {
    const short = [
      ...(arms.control.measuredAgents < MIN_ARM_SAMPLE ? ["control"] : []),
      ...(arms.treatment.measuredAgents < MIN_ARM_SAMPLE ? ["treatment"] : []),
    ].join(" and ");
    lines.push(
      `NOT YET COMPARABLE: the ${short} arm is below ${MIN_ARM_SAMPLE} measured sessions.`,
      "Whatever the two medians are, the difference between them is not evidence yet. More",
      "sessions is the only thing that changes this; waiting inside one does not.",
    );
  }
  return lines;
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
  ];
  if (metrics.cohort.since !== null || metrics.cohort.until !== null) {
    // Stated rather than implied: a cohort reading and a whole-history reading look identical
    // otherwise, and confusing the two is how a treatment median gets compared against itself.
    lines.push(
      `Cohort:            sessions started ${metrics.cohort.since ?? "any time"} to ${metrics.cohort.until ?? "now"}`,
      `Excluded:          ${metrics.excludedByCohort} session(s) started outside it`,
    );
  }
  if (metrics.arms !== undefined) lines.push("", ...renderArms(metrics.arms));
  lines.push("");
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
