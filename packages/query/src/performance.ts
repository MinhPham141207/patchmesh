import type { ProtocolEvent } from "patchmesh-protocol";
import {
  hostForSourceId,
  tierForSourceId,
} from "patchmesh-recorder";
import type { CoverageTier } from "patchmesh-recorder";
import { readWindowCached } from "patchmesh-storage";
import { findOverlappingWork } from "./overlap.js";
import { findRoleForAgent, globMatchesPath, loadRoleConfig } from "./roles.js";
import type { RoleConfig } from "patchmesh-protocol";
import { measureTimeToResume } from "./resume.js";
import { ReadServiceError } from "./types.js";

/**
 * Per-agent performance: observed work, not worker quality.
 *
 * Every figure carries its sample size (`n`) and host tier, because a count
 * without a tier compares a watched agent against an unwatched one and a rate
 * without an `n` compares a habit against an anecdote. There is deliberately
 * no composite score: one number that blends density, rework, and contention
 * would hide which of them moved, which is the only part anyone can act on.
 * Below {@link PERFORMANCE_MIN_SAMPLE} calls a row declines to be read as a
 * result and says "too thin to compare" instead.
 */
export interface AgentPerformance {
  readonly agentId: string;
  readonly host: string;
  readonly hostTier: CoverageTier | "unknown";
  readonly roleId: string | null;
  /** Calls before first change, from the resume measure. Null when the agent never changed anything. */
  readonly resumeCalls: number | null;
  /** file.changed / tool.completed. */
  readonly effectDensity: number;
  /** Share of this agent's writes another agent rewrote inside the window. */
  readonly reworkRate: number;
  /** Overlaps where this agent wrote first and was still going. */
  readonly contentionCaused: number;
  /** Share of writes inside the role's owns scope. Null when the agent holds no role. */
  readonly scopeAdherence: number | null;
  /** tool.completed events in the window: the sample every figure above rests on. */
  readonly n: number;
  readonly thin: boolean;
}

export interface PerformanceReport {
  readonly agents: readonly AgentPerformance[];
  readonly withinMinutes: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly roleFilter: string | null;
  readonly hostFilter: string | null;
}

export interface PerformanceOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly withinMinutes?: number | undefined;
  readonly role?: string | undefined;
  readonly host?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export const PERFORMANCE_MIN_SAMPLE = 5;
const PERFORMANCE_EVENT_TYPES = ["tool.completed", "file.changed"] as const;

interface ChangeRecord {
  readonly at: string;
  readonly agentId: string | null;
  readonly resourceId: string;
  readonly locator: string;
}

function changeOf(event: ProtocolEvent): ChangeRecord | null {
  if (event.eventType !== "file.changed") return null;
  const payload = event.payload as unknown as Record<string, unknown>;
  const resource = payload["resource"] as { resourceId?: unknown; locator?: unknown } | undefined;
  if (typeof resource?.resourceId !== "string") return null;
  return {
    at: event.timestamp,
    agentId: event.agentId,
    resourceId: resource.resourceId,
    locator: typeof resource.locator === "string" ? resource.locator : "",
  };
}

/** Dominant source id per agent, by event count. */
function dominantSources(events: readonly ProtocolEvent[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const event of events) {
    if (event.agentId === null) continue;
    const sourceId = event.source?.sourceId;
    if (typeof sourceId !== "string") continue;
    let perAgent = counts.get(event.agentId);
    if (perAgent === undefined) {
      perAgent = new Map();
      counts.set(event.agentId, perAgent);
    }
    perAgent.set(sourceId, (perAgent.get(sourceId) ?? 0) + 1);
  }
  const dominant = new Map<string, string>();
  for (const [agentId, perAgent] of counts) {
    let best: string | null = null;
    let bestCount = -1;
    for (const [sourceId, count] of perAgent) {
      if (count > bestCount) {
        best = sourceId;
        bestCount = count;
      }
    }
    if (best !== null) dominant.set(agentId, best);
  }
  return dominant;
}

function hostMatches(sourceId: string, filter: string): boolean {
  const needle = filter.toLowerCase();
  const provenance = hostForSourceId(sourceId);
  if (provenance !== null) {
    if (provenance.displayName.toLowerCase().includes(needle)) return true;
    const tier = tierForSourceId(sourceId);
    if (tier !== null && tier.includes(needle)) return true;
  }
  return sourceId.toLowerCase().includes(needle);
}

export function measurePerformance(options: PerformanceOptions): PerformanceReport {
  const withinMinutes = Math.max(options.withinMinutes ?? 60 * 24, 1);
  const now = (options.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - withinMinutes * 60_000);
  const roleFilter = options.role ?? null;
  const hostFilter = options.host ?? null;

  let events: readonly ProtocolEvent[];
  try {
    events = readWindowCached(
      options.ledgerPath,
      { eventTypes: [...PERFORMANCE_EVENT_TYPES], since: since.toISOString() },
      { validate: false },
    );
  } catch {
    throw new ReadServiceError("unavailable", "performance needs a readable ledger");
  }

  const completedByAgent = new Map<string, number>();
  const changesByAgent = new Map<string, ChangeRecord[]>();
  const changesByResource = new Map<string, ChangeRecord[]>();
  for (const event of events) {
    if (event.eventType === "tool.completed") {
      if (event.agentId === null) continue;
      completedByAgent.set(event.agentId, (completedByAgent.get(event.agentId) ?? 0) + 1);
      continue;
    }
    const change = changeOf(event);
    if (change === null || change.agentId === null) continue;
    const perAgent = changesByAgent.get(change.agentId) ?? [];
    perAgent.push(change);
    changesByAgent.set(change.agentId, perAgent);
    const perResource = changesByResource.get(change.resourceId) ?? [];
    perResource.push(change);
    changesByResource.set(change.resourceId, perResource);
  }

  // Rework: a write followed by a different agent's write to the same resource.
  const reworked = new Map<string, number>();
  for (const records of changesByResource.values()) {
    const ordered = [...records].sort((left, right) => left.at.localeCompare(right.at));
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const first = ordered[index]!;
      const second = ordered[index + 1]!;
      if (first.agentId !== null && second.agentId !== null && first.agentId !== second.agentId) {
        reworked.set(first.agentId, (reworked.get(first.agentId) ?? 0) + 1);
      }
    }
  }

  // Contention caused: overlaps in the same window where this agent wrote first.
  const contentionByAgent = new Map<string, number>();
  try {
    const overlaps = findOverlappingWork({
      worktreeRoot: options.worktreeRoot,
      ledgerPath: options.ledgerPath,
      withinMinutes,
      now: () => now,
    });
    for (const overlap of overlaps.overlaps) {
      const agentId = overlap.contention.earlierWorkerAgentId;
      if (agentId === null) continue;
      contentionByAgent.set(agentId, (contentionByAgent.get(agentId) ?? 0) + 1);
    }
  } catch {
    // Best-effort: contention counts enrich the report but must not sink it.
  }

  // Resume: one read for every agent, joined by id.
  const resumeByAgent = new Map<string, number | null>();
  try {
    const resume = measureTimeToResume({ ledgerPath: options.ledgerPath });
    for (const row of resume.agents) resumeByAgent.set(row.agentId, row.callsBeforeFirstChange);
  } catch {
    // Best-effort, like contention above.
  }

  // Roles: config once, one cached lookup per agent. Best-effort: without a config
  // every agent is unassigned and scope adherence is null rather than wrong.
  let roleConfig: RoleConfig | null = null;
  try {
    roleConfig = loadRoleConfig(options.worktreeRoot);
  } catch {
    roleConfig = null;
  }
  const roleCache = new Map<string, string | null>();
  const roleFor = (agentId: string): string | null => {
    if (roleConfig === null || roleCache.has(agentId)) return roleCache.get(agentId) ?? null;
    let roleId: string | null = null;
    try {
      roleId = findRoleForAgent({
        worktreeRoot: options.worktreeRoot,
        ledgerPath: options.ledgerPath,
        agentId,
        config: roleConfig,
      })?.id ?? null;
    } catch {
      roleId = null;
    }
    roleCache.set(agentId, roleId);
    return roleId;
  };

  const sources = dominantSources(events);
  const agentIds = new Set<string>([...completedByAgent.keys(), ...changesByAgent.keys()]);
  const agents: AgentPerformance[] = [];
  for (const agentId of [...agentIds].sort()) {
    const n = completedByAgent.get(agentId) ?? 0;
    const writes = changesByAgent.get(agentId) ?? [];
    const sourceId = sources.get(agentId) ?? null;
    const tier = sourceId === null ? null : tierForSourceId(sourceId);
    const host = sourceId === null
      ? "unknown"
      : (hostForSourceId(sourceId)?.displayName ?? sourceId);
    if (hostFilter !== null && (sourceId === null || !hostMatches(sourceId, hostFilter))) continue;
    const roleId = roleFor(agentId);
    if (roleFilter !== null && roleId !== roleFilter) continue;
    const owns = roleId === null
      ? null
      : (roleConfig?.roles.find((candidate) => candidate.id === roleId)?.owns ?? null);
    let inScope = 0;
    if (owns !== null) {
      for (const write of writes) {
        if (write.locator !== "" && owns.some((pattern) => globMatchesPath(pattern, write.locator))) {
          inScope += 1;
        }
      }
    }
    agents.push({
      agentId,
      host,
      hostTier: tier ?? "unknown",
      roleId,
      resumeCalls: resumeByAgent.get(agentId) ?? null,
      effectDensity: n > 0 ? writes.length / n : 0,
      reworkRate: writes.length > 0 ? (reworked.get(agentId) ?? 0) / writes.length : 0,
      contentionCaused: contentionByAgent.get(agentId) ?? 0,
      scopeAdherence: owns !== null && writes.length > 0 ? inScope / writes.length : null,
      n,
      thin: n < PERFORMANCE_MIN_SAMPLE,
    });
  }

  return {
    agents,
    withinMinutes,
    windowStart: since.toISOString(),
    windowEnd: now.toISOString(),
    roleFilter,
    hostFilter,
  };
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Render a performance report. Thin rows name their sample size instead of
 * printing rates; nothing here blends into a score.
 */
export function renderPerformance(report: PerformanceReport): string {
  const scope = [
    report.roleFilter !== null ? `role ${report.roleFilter}` : null,
    report.hostFilter !== null ? `host ${report.hostFilter}` : null,
  ].filter((part) => part !== null);
  const header =
    `Performance is observed work, not worker quality. Window: last ${report.withinMinutes}m` +
    (scope.length > 0 ? ` (${scope.join(", ")})` : "") +
    ".";
  if (report.agents.length === 0) return `${header}\nNo agent activity in the window.`;
  const rows = report.agents.map((agent) => {
    const identity = `${agent.agentId} [${agent.host} / ${agent.hostTier}]${agent.roleId !== null ? ` as ${agent.roleId}` : ""} (n=${agent.n})`;
    if (agent.thin) return `- ${identity}: too thin to compare (n=${agent.n} < ${PERFORMANCE_MIN_SAMPLE})`;
    const scopePart = agent.scopeAdherence === null ? "scope n/a (no role)" : `scope ${formatRate(agent.scopeAdherence)}`;
    const resumePart = agent.resumeCalls === null ? "resume n/a (no change yet)" : `resume ${agent.resumeCalls} call(s)`;
    return (
      `- ${identity}: density ${agent.effectDensity.toFixed(2)} changes/call, ` +
      `rework ${formatRate(agent.reworkRate)}, contention caused ${agent.contentionCaused}, ` +
      `${scopePart}, ${resumePart}`
    );
  });
  return `${header}\n${rows.join("\n")}`;
}
