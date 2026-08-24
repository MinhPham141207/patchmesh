import { readEventsCached } from "patchmesh-storage";
import type { ProtocolEvent } from "patchmesh-protocol";

/**
 * How often agents actually choose to ask PatchMesh anything, counted from the ledger.
 *
 * Adoption used to be read off `answers.ndjson`, and that file cannot support the claim. It
 * counted the hook's own injections alongside agent calls, dropped every call that failed,
 * and accepted writes from any local process -- a benchmark script wrote 25 rows that were
 * indistinguishable from adoption. Compared against the ledger the two disagreed in both
 * directions: 7 recalls requested against 4 logged, 4 recaps requested against 5 logged.
 *
 * The ledger already holds the answer and holds it better. Every tool call an agent makes is
 * recorded as `tool.requested` with the host's tool name, so an MCP call to this server is
 * just a row -- attributed to a session, in order, including the ones that failed. If the
 * product cannot count its own calls from its own event store, the event store is the thing
 * that needs fixing.
 *
 * The comparison against other MCP servers is the point, not decoration. A count of PatchMesh
 * calls on its own has no scale: 14 is small or large depending on how often this agent calls
 * any tool of this kind. Measured here, the memory server in the same repository, used by the
 * same agents in the same sessions, had 152. See docs/problems/PM-15 and PM-13.
 */

const MCP_PREFIX = "mcp__";
const PATCHMESH_PREFIX = "mcp__patchmesh__";

export interface ToolAdoption {
  readonly tool: string;
  readonly calls: number;
  /** Distinct sessions that called it, so one enthusiastic session is not read as adoption. */
  readonly sessions: number;
}

export interface ServerAdoption {
  readonly server: string;
  readonly calls: number;
  readonly sessions: number;
}

export interface AdoptionMetrics {
  /** Every `tool.requested` with an attributed session, which is the denominator. */
  readonly totalCalls: number;
  readonly patchmeshCalls: number;
  /** Calls per PatchMesh call: the "one voluntary question per N tool calls" figure. */
  readonly callsPerAsk: number | null;
  readonly sessions: number;
  /** Sessions that asked PatchMesh at least once. The number a push surface exists to move. */
  readonly sessionsThatAsked: number;
  readonly byTool: readonly ToolAdoption[];
  /** Every MCP server seen in the ledger, most-called first, PatchMesh among them. */
  readonly byServer: readonly ServerAdoption[];
  readonly firstEventAt: string | null;
  readonly lastEventAt: string | null;
}

export interface AdoptionOptions {
  readonly ledgerPath: string;
  /** Select sessions by when they started, exactly as the resume metric does. */
  readonly since?: string | undefined;
}

function payloadOf(event: ProtocolEvent): Record<string, unknown> {
  const payload: unknown = (event as { payload?: unknown }).payload;
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

/** `mcp__patchmesh__patchmesh_recap` -> `patchmesh`. Anything else is not an MCP call. */
function serverOf(hostToolName: string): string | null {
  if (!hostToolName.startsWith(MCP_PREFIX)) return null;
  const rest = hostToolName.slice(MCP_PREFIX.length);
  const end = rest.indexOf("__");
  return end === -1 ? rest : rest.slice(0, end);
}

function increment(counts: Map<string, { calls: number; sessions: Set<string> }>, key: string, session: string): void {
  const entry = counts.get(key) ?? { calls: 0, sessions: new Set<string>() };
  entry.calls += 1;
  entry.sessions.add(session);
  counts.set(key, entry);
}

export function measureAdoption(options: AdoptionOptions): AdoptionMetrics {
  const events = readEventsCached(
    options.ledgerPath,
    { eventTypes: ["tool.requested"] },
    { validate: false },
  );

  const byTool = new Map<string, { calls: number; sessions: Set<string> }>();
  const byServer = new Map<string, { calls: number; sessions: Set<string> }>();
  const sessions = new Set<string>();
  const sessionsThatAsked = new Set<string>();
  let totalCalls = 0;
  let patchmeshCalls = 0;
  let firstEventAt: string | null = null;
  let lastEventAt: string | null = null;

  for (const event of events) {
    const agentId = event.agentId;
    // An unattributed call belongs to no session, so it cannot say whether a session asked.
    // Counting it in the denominator while it can never reach the numerator would understate
    // adoption on exactly the days attribution was worst.
    if (agentId === null) continue;
    if (options.since !== undefined && event.timestamp < options.since) continue;

    if (firstEventAt === null || event.timestamp < firstEventAt) firstEventAt = event.timestamp;
    if (lastEventAt === null || event.timestamp > lastEventAt) lastEventAt = event.timestamp;

    sessions.add(agentId);
    totalCalls += 1;

    const hostToolName = payloadOf(event)["hostToolName"];
    if (typeof hostToolName !== "string") continue;
    const server = serverOf(hostToolName);
    if (server === null) continue;
    increment(byServer, server, agentId);
    if (!hostToolName.startsWith(PATCHMESH_PREFIX)) continue;
    patchmeshCalls += 1;
    sessionsThatAsked.add(agentId);
    increment(byTool, hostToolName.slice(PATCHMESH_PREFIX.length), agentId);
  }

  const rank = <T>(
    counts: Map<string, { calls: number; sessions: Set<string> }>,
    make: (key: string, calls: number, sessions: number) => T,
  ): readonly T[] =>
    [...counts.entries()]
      .sort(([leftKey, left], [rightKey, right]) => right.calls - left.calls || (leftKey < rightKey ? -1 : 1))
      .map(([key, value]) => make(key, value.calls, value.sessions.size));

  return {
    totalCalls,
    patchmeshCalls,
    callsPerAsk: patchmeshCalls === 0 ? null : Math.round(totalCalls / patchmeshCalls),
    sessions: sessions.size,
    sessionsThatAsked: sessionsThatAsked.size,
    byTool: rank(byTool, (tool, calls, sessionCount) => ({ tool, calls, sessions: sessionCount })),
    byServer: rank(byServer, (server, calls, sessionCount) => ({ server, calls, sessions: sessionCount })),
    firstEventAt,
    lastEventAt,
  };
}

export function renderAdoption(metrics: AdoptionMetrics): string {
  if (metrics.totalCalls === 0) {
    return "No attributed tool calls recorded, so there is no adoption to measure.";
  }
  const lines = [
    "Adoption - how often agents chose to ask, counted from the ledger",
    "",
    `Sessions:          ${metrics.sessions}, of which ${metrics.sessionsThatAsked} asked PatchMesh at least once`,
    `PatchMesh calls:   ${metrics.patchmeshCalls} of ${metrics.totalCalls} attributed tool call(s)`,
    `One ask per:       ${metrics.callsPerAsk === null ? "never asked" : `${metrics.callsPerAsk} tool call(s)`}`,
    `Window:            ${metrics.firstEventAt ?? "n/a"} to ${metrics.lastEventAt ?? "n/a"}`,
    "",
  ];

  if (metrics.byTool.length === 0) {
    lines.push("  no PatchMesh tool was called in this window");
  } else {
    for (const tool of metrics.byTool) {
      lines.push(`  ${tool.tool.padEnd(28)} ${String(tool.calls).padStart(5)} call(s)  across ${tool.sessions} session(s)`);
    }
  }

  // The scale line. Without it the count above is a number with nothing to be large or small
  // against, which is how "14 calls" survived as long as it did without being alarming.
  if (metrics.byServer.length > 1) {
    lines.push("", "Against the other MCP servers these same sessions used:", "");
    for (const server of metrics.byServer) {
      const mark = server.server === "patchmesh" ? " <- this one" : "";
      lines.push(`  ${server.server.padEnd(28)} ${String(server.calls).padStart(5)} call(s)  across ${server.sessions} session(s)${mark}`);
    }
  }

  lines.push(
    "",
    "Counted from `tool.requested` rows, not from answers.ndjson: this includes calls that",
    "failed, excludes the session-start hook's own injections, and cannot be written to by a",
    "local script. A push surface can carry a session; only these rows show it choosing.",
  );
  return lines.join("\n");
}
