import type {
  AgentsView,
  DecisionExplanation,
  EventPage,
  FindingsView,
  GraphView,
  StatusView,
} from "@patchmesh/query";

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
