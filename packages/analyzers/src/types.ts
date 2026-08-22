import type { EventId, LogicalResource, ResourceVersion } from "patchmesh-protocol";

export type SupportedLanguage = "typescript" | "javascript" | "python";

export interface SourceAnalysisInput {
  readonly resource: LogicalResource;
  readonly version: ResourceVersion;
  readonly content: string;
  readonly language: SupportedLanguage | "unsupported";
  readonly sourceEventIds: readonly EventId[];
  readonly analyzer: { readonly analyzerId: string; readonly version: string };
  /** Stable configuration identity for reproducing the derived facts. */
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  /** The explicit integration target for which this source revision was analyzed. */
  readonly integrationTarget: string;
}

export interface DerivedSymbol {
  readonly name: string;
  readonly locator: string;
  readonly exported: boolean;
  readonly signature: string;
}

export interface DerivedImport {
  readonly specifier: string;
  readonly importedNames: readonly string[];
}

export interface AnalysisCoverage {
  readonly status: "sufficient" | "degraded";
  readonly reason: "supported" | "unsupported_language" | "ambiguous_parse" | "opaque_source";
}

export interface SourceAnalysisResult {
  readonly symbols: readonly DerivedSymbol[];
  readonly imports: readonly DerivedImport[];
  readonly coverage: AnalysisCoverage;
  readonly sourceEventIds: readonly EventId[];
  readonly analyzer: SourceAnalysisInput["analyzer"];
  readonly configuration: SourceAnalysisInput["configuration"];
  readonly integrationTarget: SourceAnalysisInput["integrationTarget"];
}
