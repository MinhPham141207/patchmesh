import { analyzePythonSource } from "./python.js";
import type { DerivedImport, DerivedSymbol, SourceAnalysisInput, SourceAnalysisResult } from "./types.js";

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function hasBalancedBraces(source: string): boolean {
  let depth = 0;
  for (const character of source) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function symbols(source: string, locator: string): readonly DerivedSymbol[] {
  const result: DerivedSymbol[] = [];
  const declaration = /^(export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)([^\n;{]*)/gm;
  for (const match of source.matchAll(declaration)) {
    const name = match[2];
    if (!name) continue;
    result.push({
      name,
      locator: `${locator}#${name}`,
      exported: match[1] !== undefined,
      signature: match[0].replace(/\s+/g, " ").trim(),
    });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function imports(source: string): readonly DerivedImport[] {
  const result: DerivedImport[] = [];
  const statement = /import\s+(?:([\s\S]*?)\s+from\s+)?["']([^"']+)["'];?/g;
  for (const match of source.matchAll(statement)) {
    const binding = match[1] ?? "";
    const specifier = match[2];
    if (!specifier) continue;
    const names = binding.match(/[A-Za-z_$][\w$]*/g) ?? [];
    result.push({ specifier, importedNames: sortedUnique(names.filter((name) => name !== "as" && name !== "type")) });
  }
  return result.sort((left, right) => left.specifier.localeCompare(right.specifier));
}

export function analyzeSource(input: SourceAnalysisInput): SourceAnalysisResult {
  if (input.language === "unsupported") {
    return {
      symbols: [], imports: [], coverage: { status: "degraded", reason: "unsupported_language" },
      sourceEventIds: input.sourceEventIds, analyzer: input.analyzer,
      configuration: input.configuration, integrationTarget: input.integrationTarget,
    };
  }
  if (input.language === "python") return analyzePythonSource(input);
  if (!hasBalancedBraces(input.content)) {
    return {
      symbols: [], imports: [], coverage: { status: "degraded", reason: "ambiguous_parse" },
      sourceEventIds: input.sourceEventIds, analyzer: input.analyzer,
      configuration: input.configuration, integrationTarget: input.integrationTarget,
    };
  }
  return {
    symbols: symbols(input.content, input.resource.locator),
    imports: imports(input.content),
    coverage: { status: "sufficient", reason: "supported" },
    sourceEventIds: input.sourceEventIds,
    analyzer: input.analyzer,
    configuration: input.configuration,
    integrationTarget: input.integrationTarget,
  };
}
