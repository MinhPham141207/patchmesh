import { createHash } from "node:crypto";
import type { CoverageId, EventId } from "@patchmesh/protocol";
import type {
  DerivedCoverage,
  ObservationGap,
  ObservationSnapshot,
  ObservedFileChange,
  ObservedFileState,
} from "./types.js";

export interface EffectDiff {
  readonly changes: readonly ObservedFileChange[];
  readonly gaps: readonly ObservationGap[];
}

export interface CoverageInput {
  readonly scope: string;
  readonly modes: readonly ("intercepted" | "verified" | "inferred" | "unknown")[];
  readonly gaps: readonly ObservationGap[];
  readonly evidenceEventIds: readonly EventId[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameState(left: ObservedFileState, right: ObservedFileState): boolean {
  return left.contentHash === right.contentHash && left.fileKind === right.fileKind;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function diffSnapshots(
  before: ObservationSnapshot,
  after: ObservationSnapshot,
  opaque: boolean,
): EffectDiff {
  const beforePaths = new Set(before.files.keys());
  const afterPaths = new Set(after.files.keys());
  const deletedPaths = [...beforePaths].filter((path) => !afterPaths.has(path)).sort(compareStrings);
  const createdPaths = [...afterPaths].filter((path) => !beforePaths.has(path)).sort(compareStrings);
  const pairedDeleted = new Set<string>();
  const pairedCreated = new Set<string>();
  const changes: ObservedFileChange[] = [];

  for (const deletedPath of deletedPaths) {
    const deletedState = before.files.get(deletedPath);
    if (!deletedState) continue;
    const createdPath = createdPaths.find((candidate) => {
      if (pairedCreated.has(candidate)) return false;
      const createdState = after.files.get(candidate);
      return createdState !== undefined && sameState(deletedState, createdState);
    });
    if (!createdPath) continue;
    const createdState = after.files.get(createdPath);
    if (!createdState) continue;
    pairedDeleted.add(deletedPath);
    pairedCreated.add(createdPath);
    changes.push({
      path: createdPath,
      previousPath: deletedPath,
      before: deletedState,
      after: createdState,
      changeKind: "renamed",
      outOfBand: false,
    });
  }

  for (const path of [...beforePaths].sort(compareStrings)) {
    const previous = before.files.get(path);
    const current = after.files.get(path);
    if (!previous || !current || sameState(previous, current)) continue;
    changes.push({
      path,
      before: previous,
      after: current,
      changeKind: "modified",
      outOfBand: false,
    });
  }

  for (const path of deletedPaths) {
    if (pairedDeleted.has(path)) continue;
    changes.push({
      path,
      before: before.files.get(path) ?? null,
      after: null,
      changeKind: "deleted",
      outOfBand: false,
    });
  }

  for (const path of createdPaths) {
    if (pairedCreated.has(path)) continue;
    changes.push({
      path,
      before: null,
      after: after.files.get(path) ?? null,
      changeKind: "created",
      outOfBand: false,
    });
  }

  changes.sort((left, right) => compareStrings(left.path, right.path));
  return {
    changes,
    gaps: opaque
      ? [{
          kind: "opaque",
          scope: "tool.effects",
          reason: "opaque operation effects are not prospectively enumerable",
        }]
      : [],
  };
}

function canonicalModes(modes: readonly CoverageInput["modes"][number][]): readonly CoverageInput["modes"][number][] {
  const order: readonly CoverageInput["modes"][number][] = ["intercepted", "verified", "inferred", "unknown"];
  return order.filter((mode) => modes.includes(mode));
}

export function deriveCoverage(input: CoverageInput): DerivedCoverage {
  const evidenceEventIds = [...new Set(input.evidenceEventIds)].sort(compareStrings);
  const sortedGaps = [...input.gaps]
    .sort((left, right) =>
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.scope, right.scope) ||
      compareStrings(left.reason, right.reason),
    );
  const gaps = sortedGaps.map((gap) => ({ ...gap, evidenceEventIds }));
  const hasUnknownGap = gaps.some((gap) =>
    gap.kind === "bypassed" || gap.kind === "unattributed" || gap.kind === "unverified",
  );
  const modes = canonicalModes(hasUnknownGap ? [...input.modes, "unknown"] : input.modes);
  const coverageId = `coverage_${sha256(JSON.stringify({
    scope: input.scope,
    modes,
    gaps,
    evidenceEventIds,
  })).slice(0, 32)}` as CoverageId;
  return {
    coverageId,
    scope: input.scope,
    modes,
    evidenceEventIds,
    gaps,
    presentation: gaps.length === 0 ? "sufficient" : "degraded",
  };
}
