import type { DecisionDelivery, DecisionId, FindingFeedback, FindingId } from "@patchmesh/protocol";
import type {
  AgentsView,
  DecisionExplanation,
  EventPage,
  FindingsView,
  GraphView,
  OverlapResult,
  StatusView,
} from "@patchmesh/query";
import { renderOverlap } from "@patchmesh/query";

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

export function renderStatus(status: StatusView, json: boolean): string {
  if (json) return `${JSON.stringify(status)}\n`;
  const lines = [
    "PatchMesh status",
    `Health:            ${status.health}`,
    `Store:             ${status.store.state}`,
    `Replayable:        ${status.store.replayable}`,
    `Events recorded:   ${status.eventCount}`,
    `Agents observed:   ${status.agentCount}`,
    `Tasks observed:    ${status.taskCount}`,
    `Null attribution:  ${status.nullAttributionEventCount}`,
    `Coverage:          ${status.coverage.presentation}`,
  ];
  for (const gap of status.coverage.gaps) lines.push(`Coverage gap:      ${gap.kind} ${gap.scope}`);
  return `${lines.join("\n")}\n`;
}

export function renderAgents(view: AgentsView, json: boolean): string {
  if (json) return `${JSON.stringify(view)}\n`;
  const lines = ["ID\tTASKS\tEVENTS"];
  for (const agent of view.agents) lines.push(`${agent.agentId}\t${agent.taskIds.map((taskId) => taskId ?? "-").join(",")}\t${agent.eventCount}`);
  return `${lines.join("\n")}\n`;
}

export function renderEvents(page: EventPage, json: boolean): string {
  if (json) return `${JSON.stringify(page)}\n`;
  const lines = page.events.map((event) => `${event.eventId}\t${event.timestamp}\t${event.eventType}`);
  if (lines.length === 0) lines.push("No events");
  return `${lines.join("\n")}\n`;
}

export function renderGraph(view: GraphView, json: boolean): string {
  if (json) return `${JSON.stringify(view)}\n`;
  const lines = ["WORK GRAPH"];
  for (const node of view.snapshot.nodes) lines.push(`${node.nodeId}\t${node.kind}`);
  for (const edge of view.snapshot.edges) lines.push(`${edge.fromNodeId ?? "unattributed"}\t->\t${edge.toNodeId}\t${edge.kind}`);
  for (const gap of view.coverageWarnings) lines.push(`Coverage gap: ${gap.kind} ${gap.scope}`);
  if (view.snapshot.nodes.length === 0) lines.push("No graph nodes");
  return `${lines.join("\n")}\n`;
}

export function renderFindings(view: FindingsView, json: boolean): string {
  if (json) return `${JSON.stringify(view)}\n`;
  const lines = ["FINDING\tTYPE\tSTATUS\tCONFIDENCE"];
  for (const entry of view.findings) {
    lines.push(`${entry.finding.findingId}\t${entry.finding.findingType}\t${entry.status}\t${entry.finding.confidence}`);
  }
  for (const gap of view.coverageWarnings) lines.push(`Coverage gap: ${gap.kind} ${gap.scope}`);
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
  for (const gap of view.coverageWarnings) lines.push(`Coverage gap: ${gap.kind} ${gap.scope}`);
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
