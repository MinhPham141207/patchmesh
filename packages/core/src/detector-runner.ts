import type { DetectorFinding } from "./types.js";
import {
  detectExportedContractInvalidation,
  type ConsumerContractDependencyEvidence,
  type ExportedContractChangeEvidence,
} from "./exported-contract-invalidation.js";
import { detectSameSymbolOverlap, type SymbolChangeEvidence } from "./same-symbol-overlap.js";
import {
  detectStaleReadBeforeWrite,
  type DependentWriteEvidence,
  type ResourceReadEvidence,
} from "./stale-read-before-write.js";
import { findingIdFor } from "./stable-identities.js";
import type { ResourceVersion } from "@patchmesh/protocol";

function stableFindings(candidates: readonly (DetectorFinding | null)[]): readonly DetectorFinding[] {
  const findings = new Map<string, DetectorFinding>();
  for (const finding of candidates) {
    if (finding !== null) findings.set(findingIdFor(finding), finding);
  }
  return [...findings.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, finding]) => finding);
}

/** Runs the same-symbol detector over a complete evidence slice deterministically. */
export function runSameSymbolDetector(evidence: readonly SymbolChangeEvidence[]): readonly DetectorFinding[] {
  const ordered = [...evidence].sort((left, right) => left.eventId.localeCompare(right.eventId));
  const candidates: DetectorFinding[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    for (let candidate = index + 1; candidate < ordered.length; candidate += 1) {
      const finding = detectSameSymbolOverlap(ordered[index]!, ordered[candidate]!);
      if (finding !== null) candidates.push(finding);
    }
  }
  return stableFindings(candidates);
}

/** Runs stale-read detection only across writes explicitly linked to observed reads. */
export function runStaleReadBeforeWriteDetector(
  reads: readonly ResourceReadEvidence[],
  currentVersions: readonly ResourceVersion[],
  writes: readonly DependentWriteEvidence[],
): readonly DetectorFinding[] {
  const candidates: DetectorFinding[] = [];
  for (const write of [...writes].sort((left, right) => left.eventId.localeCompare(right.eventId))) {
    const read = reads.find((candidate) => candidate.eventId === write.dependsOnReadEventId);
    if (read === undefined) continue;
    for (const current of currentVersions.filter((candidate) => candidate.resourceId === read.resourceId)) {
      const finding = detectStaleReadBeforeWrite(read, current, write);
      if (finding !== null) candidates.push(finding);
    }
  }
  return stableFindings(candidates);
}

/** Runs contract invalidation across explicitly classified changes and known consumers. */
export function runExportedContractInvalidationDetector(
  changes: readonly ExportedContractChangeEvidence[],
  consumers: readonly ConsumerContractDependencyEvidence[],
): readonly DetectorFinding[] {
  const candidates: DetectorFinding[] = [];
  for (const change of [...changes].sort((left, right) => left.eventId.localeCompare(right.eventId))) {
    for (const consumer of [...consumers].sort((left, right) => left.eventId.localeCompare(right.eventId))) {
      const finding = detectExportedContractInvalidation(change, consumer);
      if (finding !== null) candidates.push(finding);
    }
  }
  return stableFindings(candidates);
}
