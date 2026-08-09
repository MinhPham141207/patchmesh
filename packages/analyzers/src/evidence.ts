import type { EventId, LogicalResource, ResourceVersion } from "@patchmesh/protocol";

import { analyzeSource } from "./typescript.js";
import type {
  AnalysisCoverage,
  DerivedImport,
  DerivedSymbol,
  SourceAnalysisInput,
} from "./types.js";

export interface SourceFacts {
  readonly resource: LogicalResource;
  readonly version: ResourceVersion;
  readonly symbols: readonly DerivedSymbol[];
  readonly imports: readonly DerivedImport[];
  readonly coverage: AnalysisCoverage;
  readonly sourceEventIds: readonly EventId[];
  readonly analyzer: SourceAnalysisInput["analyzer"];
  readonly configuration: SourceAnalysisInput["configuration"];
  readonly integrationTarget: SourceAnalysisInput["integrationTarget"];
}

function sortedUnique(values: readonly EventId[]): readonly EventId[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Creates the immutable, side-effect-free evidence record consumed by Phase 2
 * ingestion. It intentionally does not manufacture facts when analysis is
 * degraded and never infers dependencies beyond parsed imports.
 */
export function deriveSourceFacts(input: SourceAnalysisInput): SourceFacts {
  const analysis = analyzeSource(input);
  return {
    resource: input.resource,
    version: input.version,
    symbols: analysis.symbols,
    imports: analysis.imports,
    coverage: analysis.coverage,
    sourceEventIds: sortedUnique(analysis.sourceEventIds),
    analyzer: analysis.analyzer,
    configuration: analysis.configuration,
    integrationTarget: analysis.integrationTarget,
  };
}
