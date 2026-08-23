import { posix } from "node:path";

import type { DerivedEvidenceFacts, SymbolEvidenceFact } from "./evidence-facts.js";
import type { ResourceId, ResourceVersion } from "patchmesh-protocol";
import type { ResolvedContractDependency } from "./dependency-events.js";

const supportedExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * Compiled-output extensions a TypeScript source file is imported as.
 *
 * Under NodeNext resolution a TypeScript file imports its sibling as `./lib.js`, because the
 * specifier has to name the file that will exist at runtime. The source on disk — and the file
 * whose contracts are recorded — is `lib.ts`. Matching the specifier literally therefore
 * resolves nothing in any project using the convention, including this one: every import looked
 * for a `.js` file that no analyzer had ever produced facts for, so no dependency was ever
 * resolved and `dependency.changed` could not be emitted.
 */
const RUNTIME_TO_SOURCE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

function candidateSourceLocators(consumerLocator: string, specifier: string): readonly string[] {
  if (!specifier.startsWith(".")) return [];
  const resolved = posix.normalize(posix.join(posix.dirname(consumerLocator), specifier));
  const extension = posix.extname(resolved);
  if (extension !== "") {
    const sources = RUNTIME_TO_SOURCE_EXTENSIONS[extension] ?? [];
    const withoutExtension = resolved.slice(0, resolved.length - extension.length);
    // The literal spelling stays first and stays a candidate: a project that really does import
    // a checked-in `.js` file must keep resolving to it.
    return [resolved, ...sources.map((candidate) => `${withoutExtension}${candidate}`)];
  }
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
  additionalContracts: readonly SymbolEvidenceFact[] = [],
  observedVersions: readonly { readonly resourceId: ResourceId; readonly kind: ResourceVersion["kind"]; readonly value: string | null }[] = [],
): readonly ResolvedContractDependency[] {
  const contractsByKey = new Map<string, SymbolEvidenceFact>();
  for (const contract of [...facts.flatMap((entry) => entry.exportedContracts), ...additionalContracts]) {
    const version = contract.version;
    const key = [
      contract.resource.resourceId,
      version.domain.repositoryId,
      version.domain.workspaceId,
      version.domain.worktreeId,
      version.kind,
      version.value ?? "",
    ].join(":");
    contractsByKey.set(key, contract);
  }
  const contracts = [...contractsByKey.values()];
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
             && contract.version.domain.workspaceId === entry.source.version.domain.workspaceId;
          }).filter((contract) => observedVersions.length === 0 || observedVersions.some((version) =>
            version.resourceId === contract.resource.resourceId
              && version.kind === contract.version.kind
              && version.value === contract.version.value));
        if (matches.length === 1) resolved.push({ consumer, contract: matches[0]! });
      }
    }
  }
  return resolved.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
