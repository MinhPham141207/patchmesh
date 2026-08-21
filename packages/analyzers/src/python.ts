import type { DerivedImport, DerivedSymbol, SourceAnalysisInput, SourceAnalysisResult } from "./types.js";

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Strips string literals so that a `def`, `import`, or bracket inside a string or
 * docstring cannot be mistaken for source structure. Comments are removed only
 * after literals, so a `#` inside a string is preserved.
 */
function withoutLiterals(source: string): string {
  return source
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/'''[\s\S]*?'''/g, "")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/#[^\n]*/g, "");
}

/**
 * Python has no brace structure to balance, so the equivalent fail-closed guard is
 * bracket balance plus indentation consistency. A file mixing tabs and spaces for
 * indentation is ambiguous under Python's own rules, so it is not analyzed.
 */
function isUnambiguous(source: string): boolean {
  let depth = 0;
  for (const character of source) {
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (depth < 0) return false;
  }
  if (depth !== 0) return false;

  let sawTabIndent = false;
  let sawSpaceIndent = false;
  for (const line of source.split("\n")) {
    const indent = /^[ \t]+/.exec(line)?.[0];
    if (indent === undefined || line.trim().length === 0) continue;
    if (indent.includes("\t")) sawTabIndent = true;
    if (indent.includes(" ")) sawSpaceIndent = true;
  }
  return !(sawTabIndent && sawSpaceIndent);
}

/**
 * Module-level `def`, `class`, and simple assignments. Only column-zero
 * declarations are collected: an indented `def` is a method or a closure, not a
 * module export, and attributing it at module level would invent a dependency.
 *
 * Python has no `export` keyword. A name is treated as exported when it does not
 * begin with an underscore, which is the language's own convention, unless the
 * module defines `__all__`, in which case that list is authoritative.
 */
function symbols(
  source: string,
  locator: string,
  explicitExports: ReadonlySet<string> | null,
): readonly DerivedSymbol[] {
  const result: DerivedSymbol[] = [];
  const seen = new Set<string>();
  const declaration = /^(?:(?:async\s+)?def|class)\s+([A-Za-z_]\w*)([^\n:]*)|^([A-Za-z_]\w*)\s*(?::[^\n=]+)?=(?!=)([^\n]*)/gm;
  for (const match of source.matchAll(declaration)) {
    const name = match[1] ?? match[3];
    if (name === undefined || name === "__all__" || seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      locator: `${locator}#${name}`,
      exported: explicitExports === null ? !name.startsWith("_") : explicitExports.has(name),
      signature: match[0].replace(/\s+/g, " ").trim(),
    });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * `import a.b`, `import a as b`, and `from a import x, y`. Relative `from . import x`
 * retains its leading dots in the specifier so the resolver can distinguish a
 * package-relative import from an absolute one.
 */
function imports(source: string): readonly DerivedImport[] {
  const bySpecifier = new Map<string, Set<string>>();
  const record = (specifier: string, names: readonly string[]): void => {
    const existing = bySpecifier.get(specifier) ?? new Set<string>();
    for (const name of names) existing.add(name);
    bySpecifier.set(specifier, existing);
  };

  for (const match of source.matchAll(/^from\s+([.\w]+)\s+import\s+([^\n]+)/gm)) {
    const specifier = match[1];
    const clause = match[2];
    if (specifier === undefined || clause === undefined) continue;
    if (clause.trim() === "*") {
      record(specifier, []);
      continue;
    }
    const names = (clause.match(/[A-Za-z_]\w*/g) ?? []).filter((name) => name !== "as");
    record(specifier, names);
  }

  for (const match of source.matchAll(/^import\s+([^\n]+)/gm)) {
    const clause = match[1];
    if (clause === undefined) continue;
    for (const part of clause.split(",")) {
      const specifier = /^\s*([.\w]+)/.exec(part)?.[1];
      if (specifier === undefined) continue;
      record(specifier, []);
    }
  }

  return [...bySpecifier.entries()]
    .map(([specifier, names]) => ({ specifier, importedNames: sortedUnique([...names]) }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
}

/**
 * `__all__` must be read from the original source: its entries are string literals,
 * which literal stripping removes. Returns null when the module declares no
 * `__all__`, which is the signal to fall back to the underscore convention.
 */
function declaredExports(source: string): ReadonlySet<string> | null {
  const match = /^__all__\s*(?::[^\n=]+)?=\s*[\[(]([\s\S]*?)[\])]/m.exec(source);
  if (match?.[1] === undefined) return null;
  const names = new Set<string>();
  for (const literal of match[1].match(/["']([A-Za-z_]\w*)["']/g) ?? []) {
    names.add(literal.slice(1, -1));
  }
  return names;
}

export function analyzePythonSource(input: SourceAnalysisInput): SourceAnalysisResult {
  const provenance = {
    sourceEventIds: input.sourceEventIds,
    analyzer: input.analyzer,
    configuration: input.configuration,
    integrationTarget: input.integrationTarget,
  };
  const stripped = withoutLiterals(input.content);
  if (!isUnambiguous(stripped)) {
    return { symbols: [], imports: [], coverage: { status: "degraded", reason: "ambiguous_parse" }, ...provenance };
  }
  return {
    symbols: symbols(stripped, input.resource.locator, declaredExports(input.content)),
    imports: imports(stripped),
    coverage: { status: "sufficient", reason: "supported" },
    ...provenance,
  };
}
