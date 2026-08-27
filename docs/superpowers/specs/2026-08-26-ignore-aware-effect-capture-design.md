# Ignore-Aware Effect Capture

## Goal

Prevent full filesystem observation from reading Git-ignored files before discarding them.

## Design

`NodeObservationBoundary` will ask Git for the repository's tracked and untracked-but-not-ignored paths with `git ls-files --cached --others --exclude-standard -z`. Full observation will use that set to prune directories and files before hashing. The existing recursive walk remains the fallback when Git is unavailable or the workspace is not a Git repository.

The existing hard-coded observation exclusions remain in force, so `.git`, `node_modules`, and `.evidence/runtime` are excluded even if tracked. Incremental watcher capture is unchanged because it already filters watcher candidates before hashing.

## Failure behavior

Git enumeration failure falls back to the current full walk. Observation remains fail-open: failure to optimize enumeration must not suppress real file observation.

The ingest binary skips effect observation when its journal claim contains no ingested calls. This preserves `SessionEnd` as a fallback drain without repeating the full effect scan after a successful `Stop` drain.

## Validation

Add a real temporary Git repository containing a Git-ignored file and a visible file. Full capture must omit the ignored path and include the visible path. Run the focused observation test suite, typecheck, and workspace checks as time permits.

## Deliberate ceiling

This change removes ignored-tree traversal and duplicate empty-drain scans but still hashes all tracked and nonignored files during a real full capture. A cross-process persistent watcher can replace that scan later when lifecycle, locking, crash recovery, and reconciliation are separately designed.
