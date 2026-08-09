import { posix } from "node:path";

import type { DerivedEvidenceFacts, SymbolEvidenceFact } from "./evidence-facts.js";
import type { ResolvedContractDependency } from "./dependency-events.js";

const supportedExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

function candidateSourceLocators(consumerLocator: string, specifier: string): readonly string[] {
  if (!specifier.startsWith(".")) return [];
  const resolved = posix.normalize(posix.join(posix.dirname(consumerLocator), specifier));
  const extension = posix.extname(resolved);
  if (extension !== "") return [resolved];
  return [
    ...supportedExtensions.map((candidate) => `${resolved}${candidate}`),
    ...supportedExtensions.map((candidate) => `${resolved}/index${candidate}`),
  ];
}

/**
 * Resolves only unambiguous relative imports to exported symbols in an explicitly
 * supplied fact set. Bare specifiers, missing files, and ambiguous exports remain
 * unresolved so callers can degrade coverage instead of inventing dependencies.
 */
export function resolveLocalContractDependencies(
  facts: readonly DerivedEvidenceFacts[],
): readonly ResolvedContractDependency[] {
  const contracts = facts.flatMap((entry) => entry.exportedContracts);
  const resolved: ResolvedContractDependency[] = [];
  for (const entry of facts) {
    if (entry.source.coverage.status !== "sufficient") continue;
    for (const consumer of entry.consumerImports) {
      const targetLocators = new Set(candidateSourceLocators(entry.source.resource.locator, consumer.specifier));
      if (targetLocators.size === 0) continue;
      for (const name of consumer.importedNames) {
        const matches = contracts.filter((contract) => {
          const [sourceLocator, symbolName] = contract.resource.locator.split("#", 2);
          return sourceLocator !== undefined
            && symbolName === name
            && targetLocators.has(sourceLocator)
            && contract.sourceFacts.integrationTarget === entry.source.integrationTarget
            && contract.sourceFacts.resource.repositoryId === entry.source.resource.repositoryId
            && contract.version.domain.repositoryId === entry.source.version.domain.repositoryId
            && contract.version.domain.workspaceId === entry.source.version.domain.workspaceId
            && contract.version.domain.worktreeId === entry.source.version.domain.worktreeId;
        });
        if (matches.length === 1) resolved.push({ consumer, contract: matches[0]! });
      }
    }
  }
  return resolved.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
