import type { AgentsView, EventPage, GraphView, StatusView } from "@patchmesh/query";

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
