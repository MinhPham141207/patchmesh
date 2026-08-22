import { createHash } from "node:crypto";

import type {
  CoverageId,
  LogicalResource,
  ResourceId,
  ResourceVersion,
} from "patchmesh-protocol";

import { deriveSourceFacts, type SourceFacts } from "./evidence.js";
import type { SourceAnalysisInput } from "./types.js";

export interface SymbolEvidenceFact {
  readonly resource: LogicalResource;
  readonly version: ResourceVersion;
  readonly exported: boolean;
  readonly signature: string;
  readonly coverageId: CoverageId;
  readonly sourceFacts: SourceFacts;
}

export interface ConsumerImportFact {
  readonly consumer: LogicalResource;
  readonly consumerVersion: ResourceVersion;
  readonly specifier: string;
  readonly importedNames: readonly string[];
  readonly coverageId: CoverageId;
  readonly sourceFacts: SourceFacts;
}

export interface DerivedEvidenceFacts {
  readonly source: SourceFacts;
  readonly coverageId: CoverageId;
  readonly symbols: readonly SymbolEvidenceFact[];
  readonly exportedContracts: readonly SymbolEvidenceFact[];
  readonly consumerImports: readonly ConsumerImportFact[];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function symbolResource(source: SourceFacts, locator: string): LogicalResource {
  return {
    resourceId: `res_${digest(`${source.resource.resourceId}:${locator}`)}` as ResourceId,
    repositoryId: source.resource.repositoryId,
    kind: "symbol",
    locator,
  };
}

function sorted<T>(values: readonly T[], by: (value: T) => string): readonly T[] {
  return [...values].sort((left, right) => by(left).localeCompare(by(right)));
}

/**
 * Materializes auditable Phase 2 source facts. This is deliberately pure: callers
 * decide when to persist the resulting symbol or dependency events. File-only
 * runtime observations never enter this function as symbol reads.
 */
export function deriveEvidenceFacts(input: SourceAnalysisInput): DerivedEvidenceFacts {
  const source = deriveSourceFacts(input);
  const coverageId = `coverage_${digest(JSON.stringify({
    analyzer: source.analyzer,
    configuration: source.configuration,
    integrationTarget: source.integrationTarget,
    resourceId: source.resource.resourceId,
    version: source.version,
    sourceEventIds: source.sourceEventIds,
    coverage: source.coverage,
  })).slice(0, 32)}` as CoverageId;
  const symbols = sorted(source.symbols.map((symbol) => {
    const resource = symbolResource(source, symbol.locator);
    return {
      resource,
      version: {
        resourceId: resource.resourceId,
        domain: source.version.domain,
        kind: "symbol_signature" as const,
        value: digest(symbol.signature),
        evidenceEventIds: source.sourceEventIds,
      },
      exported: symbol.exported,
      signature: symbol.signature,
      coverageId,
      sourceFacts: source,
    };
  }), (fact) => fact.resource.locator);
  const consumerImports = sorted(source.imports.map((entry) => ({
    consumer: source.resource,
    consumerVersion: source.version,
    specifier: entry.specifier,
    importedNames: entry.importedNames,
    coverageId,
    sourceFacts: source,
  })), (fact) => `${fact.specifier}:${fact.importedNames.join(",")}`);

  return {
    source,
    coverageId,
    symbols,
    exportedContracts: symbols.filter((symbol) => symbol.exported),
    consumerImports,
  };
}
