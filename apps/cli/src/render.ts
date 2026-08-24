import type { DecisionDelivery, DecisionId, FindingFeedback, FindingId } from "patchmesh-protocol";
import type {
  AgentsView,
  AgentView,
  DecisionExplanation,
  EventPage,
  FindingsView,
  GraphNode,
  GraphView,
  OverlapResult,
  RecapResult,
  StatusView,
} from "patchmesh-query";
import { renderOverlap, renderRecap as renderRecapText } from "patchmesh-query";

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
 */
function coverageSummary(coverage: StatusView["coverage"]): string {
  if (coverage.total === 0) return coverage.presentation;
  const percent = Math.round((coverage.covered / coverage.total) * 100);
  return `${percent}% (${coverage.covered}/${coverage.total} scopes) ${coverage.presentation}`;
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

export function renderStatus(status: StatusView, json: boolean): string {
  if (json) {
    const bounded = boundGaps(status.coverage.gaps as readonly CoverageGap[]);
    return `${JSON.stringify({
      ...status,
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
    `Null attribution:  ${status.nullAttributionEventCount}`,
    `Coverage:          ${coverageSummary(status.coverage)}`,
  ];
  for (const line of coverageGapLines(status.coverage.gaps)) lines.push(`Coverage gap:      ${line}`);
  return `${lines.join("\n")}\n`;
}

/**
 * A subagent's parent is already in its id.
 *
 * The recorder names a subagent `<parentPrefix>.sub.<taskSuffix>`, so the relationship
 * between a parent and the work it spawned is recorded and was being thrown away by a flat
 * list sorted by string. Grouping by that prefix is the difference between eleven unrelated
 * UUIDs and one agent that ran five subagents.
 */
function agentSortKeys(agents: readonly AgentView[]): ReadonlyMap<string, string> {
  const parents = agents.map((agent) => agent.agentId).filter((agentId) => !agentId.includes(".sub."));
  const keys = new Map<string, string>();
  for (const agent of agents) {
    const marker = agent.agentId.indexOf(".sub.");
    if (marker === -1) {
      // The trailing separator keeps a parent ahead of its own subagents without putting it
      // ahead of an unrelated agent that merely sorts nearby.
      keys.set(agent.agentId, `${agent.agentId}\t`);
      continue;
    }
    // The prefix is a truncation of the parent's id, not the whole thing, so it has to be
    // resolved against the agents actually present rather than compared as a string.
    const prefix = agent.agentId.slice(0, marker);
    const parent = parents.find((agentId) => agentId.startsWith(prefix)) ?? prefix;
    keys.set(agent.agentId, `${parent}\t${agent.agentId.slice(marker)}`);
  }
  return keys;
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

  const keys = agentSortKeys(view.agents);
  const key = (agent: AgentView) => keys.get(agent.agentId) ?? agent.agentId;
  const rows = [...view.agents]
    .sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0))
    .map((agent) => {
      const isSubagent = agent.agentId.includes(".sub.");
      const named = agent.taskIds.filter((taskId) => taskId !== null).length;
      return {
        // Indentation carries the parent relationship, so the id column stays the id column.
        label: `${isSubagent ? "  ↳ " : ""}${agent.agentId}`,
        tasks: agent.taskIds.includes(null) ? `${named} (+unattributed)` : `${named}`,
        events: `${agent.eventCount}`,
      };
    });

  const width = (values: readonly string[]) => Math.max(...values.map((value) => value.length));
  const idWidth = width([...rows.map((row) => row.label), "AGENT"]);
  const taskWidth = width([...rows.map((row) => row.tasks), "TASKS"]);
  const lines = [`${"AGENT".padEnd(idWidth)}  ${"TASKS".padEnd(taskWidth)}  EVENTS`];
  for (const row of rows) {
    lines.push(`${row.label.padEnd(idWidth)}  ${row.tasks.padEnd(taskWidth)}  ${row.events.padStart(6)}`);
  }
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

export function renderFindings(view: FindingsView, json: boolean): string {
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
  const lines = ["FINDING\tTYPE\tSTATUS\tCONFIDENCE"];
  for (const entry of view.findings) {
    lines.push(`${entry.finding.findingId}\t${entry.finding.findingType}\t${entry.status}\t${entry.finding.confidence}`);
  }
  for (const line of coverageGapLines(view.coverageWarnings)) lines.push(`Coverage gap: ${line}`);
  if (view.findings.length === 0) lines.push("No findings");
  return `${lines.join("\n")}\n`;
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
