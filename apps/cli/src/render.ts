import type { DecisionDelivery, DecisionId, FindingFeedback, FindingId } from "patchmesh-protocol";
import type {
  AgentsView,
  AgentView,
  DecisionExplanation,
  EventPage,
  FindingsView,
  GraphNode,
  GraphView,
  InboxResult,
  OverlapResult,
  RecapResult,
  StatusView,
} from "patchmesh-query";
import { renderOverlap, renderRecap as renderRecapText } from "patchmesh-query";
import { collapseEvents, shortId, type EventsLens } from "./console-model.js";

/** Structural shape of one projection coverage gap, matching `ProjectionCoverageGap`. */
interface CoverageGap {
  readonly kind: string;
  readonly scope: string;
  readonly reason?: string;
}

/**
 * Summarize coverage gaps instead of listing every one.
 *
 * A gap's `scope` for an opaque tool call is the event id that produced it, so it is unique
 * per gap and means nothing to a person; the `reason` is the part that repeats. Printing one
 * line per gap made `status` 682 lines long against 9 lines of actual status, because a
 * hook-recorded ledger produces one opaque gap per shell command and shell commands are most
 * of what an agent runs.
 *
 * Gaps are grouped by (kind, reason) and counted. A group of one still renders as
 * `<kind> <scope>` — with a single gap the scope is the informative half, and collapsing it
 * would lose the only pointer to what fell short.
 */
function coverageGapLines(gaps: readonly CoverageGap[]): readonly string[] {
  const groups = new Map<string, { kind: string; reason: string; scopes: string[] }>();
  for (const gap of gaps) {
    const reason = gap.reason ?? "";
    const key = `${gap.kind} ${reason}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { kind: gap.kind, reason, scopes: [gap.scope] });
    else group.scopes.push(gap.scope);
  }
  return [...groups.values()].map((group) => {
    const first = group.scopes[0] ?? "";
    if (group.scopes.length === 1) return `${group.kind} ${first}`;
    const detail = group.reason === "" ? first : group.reason;
    return `${group.kind} (${group.scopes.length}) ${detail}`;
  });
}

/**
 * Coverage as a rate the reader can watch, with the word second and the number first.
 *
 * `observational` on its own is no more actionable than `degraded` was. What tells someone
 * whether recording is going well is the proportion and its direction over time, so that is
 * what leads. See docs/problems/PM-12.
 *
 * The source counts ride the same line because they answer the question the scopes cannot:
 * how much of the traffic is seen versus merely announced. Only observed-tier sources count
 * as observation, so a declared-only ledger reads `0/N sources observed` instead of borrowing
 * a confidence it has not earned.
 */
function coverageSummary(coverage: StatusView["coverage"]): string {
  if (coverage.total === 0) return coverage.presentation;
  const percent = Math.round((coverage.covered / coverage.total) * 100);
  const sources = coverage.sources ?? { observed: 0, total: 0 };
  const sourceCounts = sources.total === 0 ? "" : ` · ${sources.observed}/${sources.total} sources observed`;
  return `${percent}% (${coverage.covered}/${coverage.total} scopes) ${coverage.presentation}${sourceCounts}`;
}

/** Structural shape of a prune result, declared locally for the same reason as `AppendResult`. */
interface PruneResult {
  readonly removed: number;
  readonly retained: number;
}
/**
 * Structural shape of a storage append result. Declared here rather than imported so
 * the CLI keeps depending only on the daemon and query packages.
 */
interface AppendResult {
  readonly status: "inserted" | "duplicate" | "buffered";
  readonly event: { readonly eventId: string };
}

/**
 * A write command reports what was recorded, not just that something was. `duplicate`
 * is a successful idempotent replay of an identical response, not a failure, so it is
 * named explicitly rather than shown as a bare status word.
 */
function renderWriteResponse(result: AppendResult, lines: readonly string[], json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;
  const outcome = result.status === "inserted"
    ? "recorded"
    : result.status === "duplicate"
      ? "already recorded (identical response, no new event)"
      : "buffered until its causal parent is durable";
  return `${[...lines, `Outcome: ${outcome}`, `Event: ${result.event.eventId}`].join("\n")}\n`;
}

export function renderFeedbackResponse(
  result: AppendResult,
  findingId: FindingId,
  disposition: FindingFeedback["disposition"],
  json: boolean,
): string {
  return renderWriteResponse(result, [
    "FINDING FEEDBACK",
    `Finding: ${findingId}`,
    `Disposition: ${disposition}`,
  ], json);
}

export function renderDeliveryResponse(
  result: AppendResult,
  decisionId: DecisionId,
  state: DecisionDelivery["state"],
  json: boolean,
): string {
  return renderWriteResponse(result, [
    "DECISION DELIVERY",
    `Decision: ${decisionId}`,
    `State: ${state}`,
  ], json);
}

/** Structural shape of what `sendMail` returns, declared locally like `AppendResult`. */
interface MessageSentResult {
  readonly messageId: string;
}

export function renderMessageSent(
  result: MessageSentResult,
  input: { readonly to: string; readonly kind: string; readonly subject: string },
  json: boolean,
): string {
  if (json) return `${JSON.stringify(result)}\n`;
  return [
    "MESSAGE SENT",
    `To: ${input.to}`,
    `Kind: ${input.kind}`,
    `Subject: ${input.subject}`,
    `Message: ${result.messageId}`,
    "",
  ].join("\n");
}

/**
 * Render an inbox for a person, verdict first.
 *
 * The count answers the question the command was asked before any row does -- the same
 * discipline `agents` and the detectors follow. Rows stay one line each; the body and the
 * full ids are one `--json` away.
 */
export function renderInbox(result: InboxResult, agent: string | undefined, json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;
  const who = agent === undefined || agent === "" ? "broadcast" : shortId(agent);
  if (result.rows.length === 0) {
    const lines = [`No messages waiting for ${who}.`];
    if (result.expired > 0) lines.push(`${result.expired} expired message(s) not shown.`);
    return `${lines.join("\n")}\n`;
  }
  const lines = [`${result.rows.length} message(s) waiting for ${who}`];
  for (const row of result.rows) {
    const refs = row.refs.join(", ");
    const cells = refs === "" ? [row.fromAgentId ?? "-", row.kind, row.subject] : [row.fromAgentId ?? "-", row.kind, row.subject, refs];
    lines.push(cells.join(" · "));
  }
  if (result.withheld > 0) lines.push(`(+${result.withheld} more withheld)`);
  if (result.expired > 0) lines.push(`${result.expired} expired message(s) not shown.`);
  return `${lines.join("\n")}\n`;
}

/**
 * Confirm an acknowledgement. A refused acknowledgement is not rendered here at all: it
 * becomes a usage error in the main flow, because a person must learn their ack recorded
 * nothing -- the same rule a send validation failure follows.
 */
export function renderAckResponse(
  messageId: string,
  disposition: string,
  note: string | null | undefined,
  json: boolean,
): string {
  // A machine consumer must be able to learn what was recorded from the answer itself, the
  // same discipline a send confirmation follows.
  if (json) {
    return `${JSON.stringify({
      ok: true,
      messageId,
      disposition,
      ...(note === null || note === undefined || note === "" ? {} : { note }),
    })}\n`;
  }
  return [
    "MESSAGE ACKNOWLEDGED",
    `Message: ${messageId}`,
    `Disposition: ${disposition}`,
    "",
  ].join("\n");
}

/**
 * How many individual gaps a machine-readable answer carries before it summarizes the rest.
 *
 * The text renderer learned this already -- see `coverageGapLines` -- but only the text
 * renderer. `--json` kept dumping every gap, and because a hook-recorded ledger produces one
 * opaque gap per shell command, that grows with the ledger forever: measured on a 6,700-event
 * store, `agents --json` was 1.3MB and `status --json` 522KB, of which 522,203 bytes were
 * 2,611 per-event gap objects. A programmatic consumer is exactly the caller least able to
 * cope with an unbounded payload, and `--json` is the flag it uses.
 *
 * Twenty is enough to see what the gaps look like; the counts say how many there really are.
 */
const JSON_GAP_SAMPLE = 20;

/**
 * How many coverage records each agent carries in `agents --json`.
 *
 * Smaller than `JSON_GAP_SAMPLE` because this one multiplies: a coverage record is ~450 bytes,
 * and the list is per agent, so twenty of them across twenty-six agents is 200KB of diagnostic
 * detail attached to what a caller asked to be a list of agents. The repository-wide sample
 * lives in `status --json`, which is where someone actually debugging coverage looks; here the
 * counts are the part that answers "is this agent's work well observed".
 */
const JSON_AGENT_COVERAGE_SAMPLE = 3;

interface BoundedGaps {
  /** A sample, not the whole set. `gapsWithheld` says how much is missing. */
  readonly gaps: readonly CoverageGap[];
  readonly gapsTotal: number;
  /** Every gap counted by kind, so the total is auditable without carrying the objects. */
  readonly gapsByKind: Readonly<Record<string, number>>;
  readonly gapsWithheld: number;
}

/**
 * Bound a gap list for machine-readable output, and say what was left out.
 *
 * The field keeps its name and element type, so a consumer reading `gaps[0]` still works. What
 * changes is that it is now a page rather than the whole truth, and three sibling fields say
 * so -- the same discipline every MCP answer in this project already holds.
 */
function boundGaps(gaps: readonly CoverageGap[]): BoundedGaps {
  const byKind: Record<string, number> = {};
  for (const gap of gaps) byKind[gap.kind] = (byKind[gap.kind] ?? 0) + 1;
  return {
    gaps: gaps.slice(0, JSON_GAP_SAMPLE),
    gapsTotal: gaps.length,
    gapsByKind: byKind,
    gapsWithheld: Math.max(gaps.length - JSON_GAP_SAMPLE, 0),
  };
}

export function renderStatus(status: StatusView, undeliveredMessages: number, json: boolean): string {
  if (json) {
    const bounded = boundGaps(status.coverage.gaps as readonly CoverageGap[]);
    return `${JSON.stringify({
      ...status,
      undeliveredMessages,
      coverage: {
        ...status.coverage,
        gaps: bounded.gaps,
        gapsTotal: bounded.gapsTotal,
        gapsByKind: bounded.gapsByKind,
        gapsWithheld: bounded.gapsWithheld,
      },
    })}\n`;
  }
  const lines = [
    "PatchMesh status",
    `Health:            ${status.health}`,
    `Store:             ${status.store.state}`,
    `Replayable:        ${status.store.replayable}`,
    `Events recorded:   ${status.eventCount}`,
    `Agents observed:   ${status.agentCount}`,
    `Tasks observed:    ${status.taskCount}`,
    // Mailbox health rides beside the observation counts: mail waiting on nobody's action is
    // the one number here that says an agent owes another agent something. Computed by the
    // caller (`undeliveredCount`), which fails soft to zero when the ledger is unreadable.
    `Undelivered messages: ${undeliveredMessages}`,
    `Null attribution:  ${status.nullAttributionEventCount}`,
    `Coverage:          ${coverageSummary(status.coverage)}`,
  ];
  for (const line of coverageGapLines(status.coverage.gaps)) lines.push(`Coverage gap:      ${line}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Bound a per-agent projection-coverage list, which is a different shape from a gap list.
 *
 * Each `ProjectionCoverage` carries its own nested `gaps`, so this array is the larger of the
 * two offenders: 26 agents x ~196 coverage records made `agents --json` 1.3MB. Counted by
 * `presentation`, because that is the field a caller actually branches on.
 */
function boundCoverage(coverage: readonly { presentation: string }[]): {
  readonly sample: readonly unknown[];
  readonly total: number;
  readonly byPresentation: Readonly<Record<string, number>>;
  readonly withheld: number;
} {
  const byPresentation: Record<string, number> = {};
  for (const entry of coverage) byPresentation[entry.presentation] = (byPresentation[entry.presentation] ?? 0) + 1;
  // The sampled records carry their own nested gap lists, and those are unbounded too: capping
  // the outer array alone left `agents --json` at 181KB. Bounding both is what makes the answer
  // a function of the sample size rather than of how much happened.
  const sample = coverage.slice(0, JSON_AGENT_COVERAGE_SAMPLE).map((entry) => {
    const nested = (entry as { gaps?: readonly CoverageGap[] }).gaps ?? [];
    const boundedNested = boundGaps(nested);
    return {
      ...entry,
      gaps: boundedNested.gaps,
      gapsTotal: boundedNested.gapsTotal,
      gapsByKind: boundedNested.gapsByKind,
      gapsWithheld: boundedNested.gapsWithheld,
    };
  });
  return {
    sample,
    total: coverage.length,
    byPresentation,
    withheld: Math.max(coverage.length - JSON_AGENT_COVERAGE_SAMPLE, 0),
  };
}

export function renderAgents(view: AgentsView, json: boolean): string {
  if (json) {
    const agents = view.agents.map((agent) => {
      const bounded = boundCoverage(agent.coverage ?? []);
      return {
        ...agent,
        coverage: bounded.sample,
        coverageTotal: bounded.total,
        coverageByPresentation: bounded.byPresentation,
        coverageWithheld: bounded.withheld,
      };
    });
    return `${JSON.stringify({ ...view, agents })}\n`;
  }
  if (view.agents.length === 0) return "No agents observed.\n";

  // Busiest first, subagents tucked under their parent. Alphabetical order by UUID - what this
  // used to be - is a random order wearing a deterministic one's clothes, and a full
  // 36-character id column is a table with no signal; the short form is what `recap` taught.
  const parents = [...view.agents].filter((agent) => !agent.agentId.includes(".sub."));
  const rankOf = new Map<string, number>(
    [...parents]
      .sort((left, right) => right.eventCount - left.eventCount)
      .map((agent, index) => [agent.agentId, index]),
  );
  const sortKey = (agent: AgentView): string => {
    const marker = agent.agentId.indexOf(".sub.");
    if (marker === -1) return `${rankOf.get(agent.agentId) ?? parents.length}\t0\t${agent.agentId}`;
    const prefix = agent.agentId.slice(0, marker);
    const parent = view.agents.find((other) => other.agentId.startsWith(prefix))?.agentId ?? prefix;
    return `${rankOf.get(parent) ?? parents.length}\t1\t${agent.agentId.slice(marker)}`;
  };
  const rows = [...view.agents]
    .sort((left, right) => (sortKey(left) < sortKey(right) ? -1 : sortKey(left) > sortKey(right) ? 1 : 0))
    .map((agent) => {
      const isSubagent = agent.agentId.includes(".sub.");
      const named = agent.taskIds.filter((taskId) => taskId !== null).length;
      // Host provenance rides the id column so every row answers "who recorded this" without
      // a second lookup. An unrecognized source is named as such rather than guessed at, and
      // carries no tier: it counts neither as observation nor as declaration.
      const host = agent.host;
      const provenance = host === undefined || host.displayName === null
        ? "(unrecognized host)"
        : `${host.displayName} (${host.tier ?? "unknown tier"})`;
      return {
        // Indentation carries the parent relationship, so the id column stays the id column.
        label: `${isSubagent ? "  ↳ " : ""}${shortId(String(agent.agentId))} · ${provenance}`,
        tasks: agent.taskIds.includes(null) ? `${named} (+unattributed)` : `${named}`,
        events: `${agent.eventCount}`,
      };
    });

  const width = (values: readonly string[]) => Math.max(...values.map((value) => value.length));
  const idWidth = width([...rows.map((row) => row.label), "AGENT"]);
  const taskWidth = width([...rows.map((row) => row.tasks), "TASKS"]);
  const lines = [
    `${view.agents.length} agent${view.agents.length === 1 ? "" : "s"} · busiest first`,
    `${"AGENT".padEnd(idWidth)}  ${"TASKS".padEnd(taskWidth)}  EVENTS`,
  ];
  for (const row of rows) {
    lines.push(`${row.label.padEnd(idWidth)}  ${row.tasks.padEnd(taskWidth)}  ${row.events.padStart(6)}`);
  }
  lines.push("Explore everything: patchmesh console");
  return `${lines.join("\n")}\n`;
}

/** How many folded calls the terminal shows before it starts withholding. */
export const TERMINAL_CALL_ROWS = 20;

/**
 * Render the event stream as calls rather than records.
 *
 * The text mode this replaces printed every event since creation as
 * `event-id · timestamp · type` - three columns that never said what happened, oldest first,
 * so the first screen was the day the repository was created. The fold and the cap are the
 * console's own (`collapseEvents`), so both surfaces answer with the same shape.
 *
 * `--raw` keeps the old one-line-per-event format for scripts; that escape hatch is why the
 * pointer line below must never appear in it.
 */
export function renderEventCalls(lens: EventsLens): string {
  const { total, shown, withheld } = lens.bounds;
  if (total === 0) return "No events recorded.\n";
  const head = `${total} call${total === 1 ? "" : "s"} · ${lens.eventsRead} events recorded`
    + (withheld === 0 ? "" : ` · showing the newest ${shown}, ${withheld} older withheld`);
  const lines = [head];
  for (const row of lens.rows) {
    const at = row.at.length >= 19 ? row.at.slice(11, 19) : row.at;
    const more = row.moreChanged === 0 ? "" : ` (+${row.moreChanged} more files)`;
    const changed = row.changed.length === 0 ? "" : ` -> ${row.changed.join(", ")}${more}`;
    const failed = row.failed ? " [failed]" : "";
    lines.push(`${at}\t${row.agentShort ?? "-"}\t${row.tool ?? "-"}\t${row.operation ?? ""}${changed}${failed}`);
  }
  lines.push("Explore everything: patchmesh console");
  return `${lines.join("\n")}\n`;
}

export function renderEvents(page: EventPage, json: boolean): string {
  if (json) return `${JSON.stringify(page)}\n`;
  const lines = page.events.map((event) => `${event.eventId}\t${event.timestamp}\t${event.eventType}`);
  if (lines.length === 0) lines.push("No events");
  return `${lines.join("\n")}\n`;
}

/**
 * Name a graph node by what it is, not by the hash of what it is.
 *
 * A resource node carries `resource.locator` — the repository-relative path — and a version
 * node carries the resource id that resolves to one. Printing `resource:res_<sha256>` for
 * both discarded data the node already held, which is what made `graph` 1,145 lines of
 * indistinguishable hex.
 */
function graphNodeLabel(node: GraphNode, locators: ReadonlyMap<string, string>): string {
  switch (node.kind) {
    case "agent":
      return node.agentId;
    case "task":
      return node.taskId;
    case "resource":
      return node.resource.locator;
    case "version": {
      const locator = locators.get(node.version.resourceId) ?? node.version.resourceId;
      // A content hash identifies a version; eight hex digits distinguish them here and the
      // whole value stays available in --json.
      const value = node.version.value === null ? "unknown" : node.version.value.slice(0, 8);
      return `${locator}@${value}`;
    }
    default:
      return (node as { readonly nodeId: string }).nodeId;
  }
}

export function renderGraph(view: GraphView, json: boolean): string {
  if (json) return `${JSON.stringify(view)}\n`;
  const { nodes, edges } = view.snapshot;
  if (nodes.length === 0) return "WORK GRAPH\nNo graph nodes\n";

  const locators = new Map<string, string>();
  for (const node of nodes) if (node.kind === "resource") locators.set(node.resource.resourceId, node.resource.locator);

  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const node of nodes) {
    labels.set(node.nodeId, graphNodeLabel(node, locators));
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }

  // The shape of the graph before its contents: a reader scrolling a thousand rows needs to
  // know what they are scrolling through first.
  const shape = [...counts.entries()].sort().map(([kind, count]) => `${count} ${kind}`).join(", ");
  const lines = [`WORK GRAPH (${shape}; ${edges.length} edge(s))`, ""];

  for (const node of nodes) lines.push(`${node.kind}\t${labels.get(node.nodeId) ?? node.nodeId}`);
  for (const edge of edges) {
    const from = edge.fromNodeId === null ? "unattributed" : labels.get(edge.fromNodeId) ?? edge.fromNodeId;
    lines.push(`${from}\t->\t${labels.get(edge.toNodeId) ?? edge.toNodeId}\t${edge.kind}`);
  }
  for (const line of coverageGapLines(view.coverageWarnings)) lines.push(`Coverage gap: ${line}`);
  return `${lines.join("\n")}\n`;
}

/** What a detector is called in prose, so the answer names the thing rather than the flag. */
const DETECTOR_SUBJECT = {
  stale: "stale-read-before-write",
  contracts: "exported-contract invalidation",
} as const;

export function renderFindings(
  view: FindingsView,
  json: boolean,
  detector?: keyof typeof DETECTOR_SUBJECT,
): string {
  if (json) {
    const bounded = boundGaps(view.coverageWarnings as readonly CoverageGap[]);
    return `${JSON.stringify({
      ...view,
      coverageWarnings: bounded.gaps,
      coverageWarningsTotal: bounded.gapsTotal,
      coverageWarningsByKind: bounded.gapsByKind,
      coverageWarningsWithheld: bounded.gapsWithheld,
    })}\n`;
  }

  const subject = detector === undefined ? "" : `${DETECTOR_SUBJECT[detector]} `;
  const gapLines = coverageGapLines(view.coverageWarnings);

  // The verdict leads. This used to print a bare table header, then every coverage gap, and
  // only then "No findings" at the bottom - so the one line answering the question a reader
  // asked was the last thing they reached, under a wall of diagnostics. `stale` already reads
  // the right way round when it declines to run; this is the same courtesy for a detector that
  // did run.
  if (view.findings.length === 0) {
    const lines = [`No ${subject}findings.`];
    if (gapLines.length === 0) {
      lines.push("The detector ran over complete coverage, so this is a clean result.");
    } else {
      // A zero from a detector whose inputs were partly unobserved is not proof of absence,
      // and saying so is the difference between a report and a reassurance.
      lines.push(
        "The detector ran, but coverage was incomplete, so this is an absence of evidence",
        "rather than evidence of absence:",
      );
      for (const line of gapLines) lines.push(`  ${line}`);
    }
    return `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`;
  }

  const lines = ["FINDING	TYPE	STATUS	CONFIDENCE"];
  for (const entry of view.findings) {
    lines.push(`${entry.finding.findingId}	${entry.finding.findingType}	${entry.status}	${entry.finding.confidence}`);
  }
  // Kept after the findings rather than before them: a caveat on an answer belongs under the
  // answer, and these say how much of the store the detector could not see.
  if (gapLines.length > 0) {
    lines.push("", "Coverage was incomplete while this ran, so the list may be short:");
    for (const line of gapLines) lines.push(`  ${line}`);
  }
  return `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`;
}

export function renderDecisionExplanation(view: DecisionExplanation, json: boolean): string {
  if (json) return `${JSON.stringify(view)}\n`;
  const { decision } = view;
  const lines = [
    "DECISION EXPLANATION",
    `Decision: ${decision.decision.decisionId}`,
    `Finding: ${decision.decision.findingId}`,
    `Action: ${decision.decision.coordinationAction}`,
    `Directive: ${decision.decision.gatewayDirective}`,
    `State: ${decision.decision.state}`,
    `Finding status: ${view.finding?.status ?? "unavailable"}`,
    `Evidence: ${decision.decision.evidenceEventIds.join(",")}`,
  ];
  for (const delivery of decision.deliveries) lines.push(`Delivery: ${delivery.deliveryId} ${delivery.state}`);
  for (const feedback of decision.feedback) {
    lines.push(`Feedback: ${feedback.eventId} ${feedback.feedback.feedbackId} ${feedback.feedback.disposition}`);
  }
  for (const line of coverageGapLines(view.coverageWarnings)) lines.push(`Coverage gap: ${line}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Render overlapping work for a person.
 *
 * `overlaps` used to read `same_symbol_overlap` findings out of the work-graph projection.
 * On a hook-recorded ledger that projection produces no overlap findings at all - shell
 * commands are opaque, so it emits coverage gaps instead - while the same question was already
 * answered from observed file changes for agents over MCP. Two implementations of one question,
 * and the user-facing one was the broken one. This is now the same call the MCP tool makes.
 */
export function renderOverlaps(result: OverlapResult, json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;
  return `${renderOverlap(result, result.logicalPath ?? undefined)}\n`;
}

/**
 * Render a recap for a person, using the same text an agent gets over MCP.
 *
 * Deliberately not a second rendering. The recap's wording is the product of measuring what an
 * agent actually needed - what a task committed, which files it touched, what it must not claim
 * - and a person reading a terminal needs the same things. Two renderings would drift, and the
 * CLI's would be the one nobody measured.
 */
export function renderRecap(result: RecapResult, agent: string | undefined, json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;
  return `${renderRecapText(result, agent)}\n`;
}

/**
 * Explain why a detector has nothing to say about this ledger.
 *
 * Silence and inability are different answers and must not render the same. A detector whose
 * evidence was never recorded has not looked and found nothing; it cannot look at all, and
 * saying "no findings" would be a claim it has not earned.
 */
export function renderDetectorUnavailable(
  command: string,
  missing: readonly string[],
  json: boolean,
): string {
  if (json) return `${JSON.stringify({ command, available: false, missingEvidence: missing })}\n`;
  return [
    `No ${command} findings can be derived from this event store.`,
    `Missing evidence: ${missing.join(", ")}.`,
    "This detector needs evidence a host-hook recorder does not produce. Recording through an",
    "MCP proxy that declares read and dependency evidence populates it.",
    "",
  ].join("\n");
}

/**
 * Report what a prune removed.
 *
 * Names the retained count as well as the removed one, because the number that matters to
 * someone running this is what is left to answer questions with, not what went away.
 */
export function renderPrune(result: PruneResult, cutoff: Date, json: boolean): string {
  if (json) return `${JSON.stringify({ ...result, cutoff: cutoff.toISOString() })}\n`;
  if (result.removed === 0) {
    return `No events older than ${cutoff.toISOString()}. ${result.retained} event(s) retained.\n`;
  }
  return [
    `Removed ${result.removed} event(s) older than ${cutoff.toISOString()}.`,
    `${result.retained} event(s) retained, including any a retained event still depends on.`,
    "",
  ].join("\n");
}
