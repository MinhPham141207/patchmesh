# M4 Effect Observation and Coverage Design

**Status:** Approved design
**Date:** 2026-08-08

## Goal

Implement Phase 1 M4 effect observation around the existing in-process MCP proxy.
The implementation will observe repository and worktree state before and after one
tool call, normalize verified filesystem effects into the closed Phase 1 event set,
preserve process outcomes in `tool.completed`, and expose explicit degraded coverage
when the observer cannot prove the full effect boundary.

M4 remains report-only. It does not add detectors, graph projections, coordination
policy, gateway enforcement, AST or symbol analysis, or a second runtime adapter.

## Scope

In scope:

- A new `@patchmesh/observation` workspace package.
- An injected observation boundary and a Node implementation using built-in filesystem,
  crypto, and Git/process APIs.
- Repository, worktree, and revision observations at the before/after boundary.
- Repository-relative logical path normalization and content hashing.
- Normalized `file.changed` effect events for created, modified, deleted, and renamed
  files, with repository/workspace/worktree-scoped resource versions.
- Linking persisted effect event IDs into `tool.completed.payload.effectEventIds`.
- Derived coverage records with explicit modes, gaps, and degraded presentation.
- Redaction of diagnostic values before they are returned or persisted.
- Temporary repository, linked-worktree, SQLite, failure, opaque-operation, bypass,
  and security tests.
- M4 evidence documentation and current-status updates after verification.

Out of scope:

- A new protocol event type or persisted coverage event.
- AST parsing, symbol extraction, dependency analysis, findings, decisions, or policy.
- MCP transport handling or a second adapter.
- Filesystem sandboxing, kernel-level interception, or a claim that arbitrary shell
  commands are prospectively enumerable.
- Persistence of process output, Git output, environment values, raw errors, or
  credentials.

## Architectural Choice

Effect observation belongs in a separate `@patchmesh/observation` package rather than
inside `McpProxy` or a broad future analyzer package.

The package provides deterministic observation ports and facts. It does not own event
storage or runtime-specific interception. `McpProxy` remains responsible for the MCP
call lifecycle and converts returned observation facts into protocol events. This
preserves the repository boundaries:

```text
MCP adapter -> observation boundary -> normalized protocol events -> event store
```

The observer uses the IDs supplied by `McpCallContext` for protocol event domains. It
may report Git common-directory, worktree administrative-directory, and revision
metadata, but it does not derive a repository or worktree ID from a path, branch,
remote, or commit. The existing identity contract remains authoritative.

## Public API Shape

The exact implementation may refine names while preserving these responsibilities:

```ts
interface ObservationBoundary {
  captureBefore(context: ObservationContext): Promise<ObservationSnapshot>;
  captureAfter(context: ObservationContext): Promise<ObservationSnapshot>;
}

interface ObservationSnapshot {
  repository: {
    commonDirectory: string | null;
    revision: string | null;
  };
  worktree: {
    administrativeDirectory: string | null;
  };
  files: ReadonlyMap<string, ObservedFileState>;
  outOfBandChanges: readonly ObservedFileChange[];
}

interface ObservedFileState {
  contentHash: string;
  gitBlob: string | null;
  fileKind: "file" | "directory" | "symlink";
}

interface DerivedCoverage {
  coverageId: CoverageId;
  scope: string;
  modes: readonly ("intercepted" | "verified" | "inferred" | "unknown")[];
  evidenceEventIds: readonly EventId[];
  gaps: readonly CoverageGap[];
  presentation: "sufficient" | "degraded" | "unknown";
}

interface CoverageGap {
  kind: "bypassed" | "opaque" | "missing_sequence" | "unattributed" | "unverified";
  scope: string;
  reason: string;
  evidenceEventIds: readonly EventId[];
}
```

`McpProxyResult` gains a derived `coverage` value and observation diagnostics. The
existing execution, request ID, and completion ID fields remain unchanged. Event IDs,
timestamps, and observer instance metadata use injectable seams for deterministic tests.

## Event and Data Flow

For each call:

1. Validate and persist `tool.requested` using the M3 behavior. A request persistence
   failure prevents execution.
2. Capture a pre-execution observation. A failed capture does not prevent execution;
   it creates a sanitized degraded coverage gap.
3. Invoke the executor with the existing abort-signal behavior.
4. Classify the executor result as succeeded, failed, or interrupted. Unexpected throws
   become failed outcomes without retaining their error text.
5. Always attempt a post-execution observation, including failed and interrupted calls.
6. Compare snapshots and normalize file effects:
   - a new path is `created`;
   - a removed path is `deleted`;
   - changed content is `modified`;
   - a verified Git/path rename is `renamed`;
   - unchanged content produces no effect event.
7. Build each effect event with the call's repository, workspace, worktree, attribution,
   and correlation metadata. Effects are caused by the request event and carry resource
   versions whose evidence includes their own event ID.
8. Append validated effect events before `tool.completed`. Only successfully appended
   effect IDs are included in the completion payload.
9. Append `tool.completed` with the real process outcome and effect IDs. The completion
   event remains the authoritative process result.
10. Return the execution result, lifecycle event IDs, derived coverage, and sanitized
    observation diagnostics.

Normal intercepted calls with successful before/after captures produce `intercepted`
and `verified` coverage. Opaque calls may verify actual post-state changes, but always
include an `opaque` gap because the observer cannot claim to enumerate prospective
effects. An observer-supplied out-of-band change is persisted as a watcher-rooted
effect with nullable attribution and a separate correlation, never falsely linked to
the MCP request. Snapshot-only implementations cannot prove that every filesystem
mutation in the observation window came from the tool; that limitation remains an
explicit `unverified` or `bypassed` gap.

Coverage is derived for M4 and is not stored as a new event. Future M5 projections may
derive durable coverage state from effect events and observer evidence without changing
the Phase 1 event vocabulary.

## Identity, Paths, and Versions

- The observer operates beneath the configured workspace root and normalizes logical
  paths as UTF-8 NFC, repository-relative, slash-separated, and case-preserving.
- Absolute paths, backslashes, NUL bytes, empty segments, `.` segments, `..` segments,
  and trailing slashes are rejected rather than emitted as protocol resources.
- Resource IDs follow the existing repository-scoped identity formula using the
  repository ID, resource kind `file`, and normalized locator.
- Content versions use SHA-256 content hashes. Git blob and revision values are retained
  in observer facts when available; absence of Git metadata is a degraded observation,
  not a synthesized identity.
- Symlinks retain their logical path identity. Target inspection is separate evidence;
  an unreadable or escaping target creates a coverage gap.
- Linked worktrees must preserve one repository identity while retaining distinct
  worktree context supplied by the caller.

## Redaction and Security

The observer never persists raw process output, Git command output, environment values,
error objects, or command arguments beyond the already normalized operation name.
Diagnostic reasons are selected from fixed categories and sanitized before returning.
Secret-shaped values such as API keys, access tokens, passwords, authorization headers,
and embedded credentials are replaced with `<redacted>` before any diagnostic or
coverage value is constructed. Tests assert that synthetic secret sentinels cannot
appear in stored events, coverage, or diagnostics.

## Error Handling

- Request persistence remains fail-closed.
- Before/after observer failures are fail-open for execution and completion persistence.
- Git-unavailable, unreadable, out-of-root, opaque, and incomplete snapshot conditions
  produce explicit degraded gaps rather than tool failures.
- Effect append failures are recorded as sanitized observation gaps. They do not create
  verified coverage or effect IDs that were not stored.
- Completion persistence retains the M3 typed error behavior and reports that execution
  already occurred when applicable.
- A failed or interrupted executor result does not suppress post-execution observation.
- No automatic retry changes the event ordering or causes duplicate tool execution.

## Testing and Evidence

Tests will verify:

- pure snapshot diff behavior for create, modify, delete, rename, unchanged content,
  hashes, and stable resource IDs;
- Git repository and revision observation in a temporary repository;
- shared repository identity and distinct worktree contexts in a linked worktree;
- successful MCP execution persists request, effect events, and completion links;
- failed and interrupted executions persist outcomes and post-call effects;
- opaque calls return an explicit degraded opaque gap;
- observer-provided out-of-band changes are nullable-attribution watcher events;
- failed observations do not prevent execution or completion persistence;
- effect persistence failures never produce false verified coverage;
- M3 request and completion persistence errors remain unchanged;
- path traversal, symlink, and cross-worktree identity handling;
- security fixtures leave no unredacted secrets in events, coverage, or diagnostics.

Verification will run focused package tests, all workspace tests, recursive typechecks
and builds, the Phase 0 validator and suite, and `git diff --check`. M4 evidence will
record exact commands and results, the implemented observation boundary, degraded-mode
limits, and residual risk from snapshot windows and opaque shell operations.

## Alternatives Considered

### Extend `McpProxy` directly

This is the smallest file-level diff, but it couples MCP interception, filesystem and
Git inspection, hashing, redaction, and coverage policy in one runtime adapter. It
would be difficult to test independently and would make the adapter responsible for
generic repository facts.

### Add a broad `@patchmesh/analyzers` package

This matches the eventual architecture naming, but M4 does not implement AST,
dependency, or symbol analysis. Introducing the broader package now would expand the
public boundary before M5 justifies it.

### Selected approach: `@patchmesh/observation`

Use a focused observation package with injected ports and a Node implementation. It
provides the smallest coherent reusable boundary for M4, keeps the MCP adapter thin,
and leaves a later analyzer package free to own higher-level interpretation.
