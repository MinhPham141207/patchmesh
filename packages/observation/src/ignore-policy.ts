const ignoredPathSegments = new Set([".git", "node_modules"]);

/** Version bound into the canonical M0 workload contract. */
export const OBSERVATION_IGNORE_POLICY_VERSION = "phase2-observation-ignore-v1";

/** Shared by initialization, watcher candidates, reconciliation, and benchmarks. */
export function isIgnoredObservationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (normalized === ".evidence/runtime" || normalized.startsWith(".evidence/runtime/")) return true;
  return normalized.split("/").some((segment) => ignoredPathSegments.has(segment));
}
