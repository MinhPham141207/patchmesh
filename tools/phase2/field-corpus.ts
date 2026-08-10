import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type FieldDetector = "same_symbol_overlap" | "stale_read_before_write" | "exported_contract_invalidation";
export type FieldCase = {
  readonly caseId: string;
  readonly caseKind: "trace_integrity" | "detector_quality";
  readonly tracePaths: readonly string[];
  readonly scenario: string;
  readonly detector: FieldDetector | null;
  readonly expectedFinding: boolean | null;
  readonly observedFinding: boolean | null;
  readonly confidence: number | null;
  readonly reviewerId: string;
  readonly reviewedAt: string;
  readonly coverage: "sufficient" | "degraded" | "unknown";
  readonly limitations: readonly string[];
  readonly replayDigest: `sha256:${string}`;
  readonly detectorOutputDigest: `sha256:${string}` | null;
  readonly holdout: boolean;
};

export interface FieldCorpus {
  readonly schemaVersion: 1;
  readonly corpusVersion: "field-v1";
  readonly evidenceKind: "field_review";
  readonly cases: readonly FieldCase[];
}

export function validateFieldCorpus(corpus: FieldCorpus): readonly string[] {
  const diagnostics: string[] = [];
  const caseIds = new Set<string>();
  for (const entry of corpus.cases) {
    if (caseIds.has(entry.caseId)) diagnostics.push(`duplicate case ID: ${entry.caseId}`);
    caseIds.add(entry.caseId);
    if (entry.tracePaths.length === 0) diagnostics.push(`${entry.caseId}: tracePaths must not be empty`);
    if (entry.caseKind === "trace_integrity") {
      if (entry.detector !== null || entry.expectedFinding !== null || entry.observedFinding !== null) {
        diagnostics.push(`${entry.caseId}: trace-integrity cases cannot carry detector labels`);
      }
      continue;
    }
    if (entry.detector === null || entry.expectedFinding === null || entry.observedFinding === null || entry.confidence === null) {
      diagnostics.push(`${entry.caseId}: detector-quality cases require labels and confidence`);
    }
    if (entry.coverage !== "sufficient") diagnostics.push(`${entry.caseId}: detector-quality cases require sufficient coverage`);
    if (entry.detectorOutputDigest === null) diagnostics.push(`${entry.caseId}: detector output digest is required`);
    if (!entry.holdout && entry.reviewerId.length === 0) diagnostics.push(`${entry.caseId}: reviewer ID is required`);
  }
  return diagnostics.sort((left, right) => left.localeCompare(right));
}

export async function loadFieldCorpus(path: string): Promise<FieldCorpus> {
  const corpus = JSON.parse(await readFile(resolve(path), "utf8")) as FieldCorpus;
  const diagnostics = validateFieldCorpus(corpus);
  if (diagnostics.length > 0) throw new Error(diagnostics.join("; "));
  return corpus;
}
