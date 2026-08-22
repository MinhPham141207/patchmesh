import type {
  AgentId,
  CoverageId,
  EventId,
  LogicalResource,
  ResourceVersion,
  TaskId,
} from "patchmesh-protocol";
import { canonicalDigest } from "./canonical-json.js";
import type { GraphEdgeKind, ProjectionCoverageGap, ProjectionCoverageMode } from "./work-graph-types.js";

export interface CoverageIdentityInput {
  readonly scope: string;
  readonly modes: readonly ProjectionCoverageMode[];
  readonly gaps: readonly ProjectionCoverageGap[];
  readonly evidenceEventIds: readonly EventId[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

export function agentNodeId(agentId: AgentId): string {
  return `agent:${agentId}`;
}

export function taskNodeId(taskId: TaskId): string {
  return `task:${taskId}`;
}

export function resourceNodeId(resource: LogicalResource): string {
  return `resource:${resource.resourceId}`;
}

export function versionNodeId(version: ResourceVersion): string {
  return `version:${canonicalDigest({
    resourceId: version.resourceId,
    domain: version.domain,
    kind: version.kind,
    value: version.value,
  })}`;
}

export function edgeId(
  kind: GraphEdgeKind,
  fromNodeId: string | null,
  toNodeId: string,
  discriminator: string,
): string {
  return `${kind}:${fromNodeId ?? "unattributed"}:${toNodeId}:${discriminator}`;
}

export function coverageId(input: CoverageIdentityInput): CoverageId {
  const modes = sortedUnique(input.modes);
  const evidenceEventIds = sortedUnique(input.evidenceEventIds);
  const gaps = [...input.gaps]
    .map((gap) => ({
      kind: gap.kind,
      scope: gap.scope,
      reason: gap.reason,
      evidenceEventIds: sortedUnique(gap.evidenceEventIds),
    }))
    .sort((left, right) =>
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.scope, right.scope) ||
      compareStrings(left.reason, right.reason) ||
      compareStrings(left.evidenceEventIds.join(","), right.evidenceEventIds.join(",")),
    );
  return `coverage_${canonicalDigest({ scope: input.scope, modes, gaps, evidenceEventIds }).slice(0, 32)}` as CoverageId;
}
