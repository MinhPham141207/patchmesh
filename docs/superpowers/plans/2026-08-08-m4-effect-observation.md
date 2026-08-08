# M4 Effect Observation and Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic post-tool effect observation and derived degraded-coverage reporting to the existing M3 MCP proxy without widening the Phase 1 event set.

**Architecture:** Create a focused `@patchmesh/observation` package with injected observation ports, pure snapshot-diff/effect logic, and a Node implementation for filesystem and Git metadata. Keep `@patchmesh/adapters` responsible for MCP lifecycle orchestration: persist the request, capture before/after state, append normalized `file.changed` effects, then persist `tool.completed` with linked effect IDs. Coverage is returned as derived data, not persisted as a new event.

**Tech Stack:** Strict TypeScript, pnpm workspace, Node.js >=22.5 built-in `node:fs`, `node:crypto`, and `node:child_process`, existing `@patchmesh/protocol` and `@patchmesh/storage`, `node:test`, temporary repositories/worktrees, and temporary SQLite databases.

## Global Constraints

- Keep the Phase 1 event set closed: use `tool.requested`, `tool.completed`, `file.read`, `file.changed`, `symbol.read`, `symbol.changed`, `task.completed`, `dependency.changed`, and `attribution.corrected`; do not add a coverage event.
- M4 remains report-only and must not add detectors, graph projections, coordination policy, findings, decisions, disruptive directives, AST analysis, or a second adapter.
- Observation failures are fail-open for execution and completion persistence; request persistence remains fail-closed.
- Never persist or return raw process output, Git output, environment values, error objects, command arguments, credentials, or hidden reasoning.
- Normalize paths as UTF-8 NFC, repository-relative, slash-separated, case-preserving paths; reject absolute paths, backslashes, NUL bytes, empty segments, `.`, `..`, and trailing slashes.
- Use repository/workspace/worktree-scoped resource versions and the existing repository-scoped file resource ID formula; never derive opaque repository or worktree IDs from paths, branches, remotes, or commits.
- Every behavior change requires deterministic tests; use explicit assertions rather than snapshots.
- Do not modify applied migrations or introduce a new external dependency.

---

## File Map

Create these files:

- `packages/observation/package.json`: private workspace package metadata, exports, and test/typecheck/build scripts.
- `packages/observation/tsconfig.json`: strict package TypeScript configuration matching sibling packages.
- `packages/observation/src/types.ts`: observation contexts, snapshots, file facts, gaps, coverage, and boundary interfaces.
- `packages/observation/src/paths.ts`: logical path validation and repository-scoped file resource ID derivation.
- `packages/observation/src/redaction.ts`: fixed-category diagnostic sanitization and secret replacement.
- `packages/observation/src/effects.ts`: deterministic snapshot comparison, rename pairing, and coverage derivation.
- `packages/observation/src/node-observation.ts`: Node filesystem and Git observation boundary.
- `packages/observation/src/index.ts`: public observation exports.
- `packages/observation/test/effects.test.ts`: pure diff, path, resource ID, and coverage tests.
- `packages/observation/test/node-observation.test.ts`: temporary repository and filesystem integration tests.
- `docs/implementation/phase1/evidence/PHASE_1_M4_EVIDENCE.md`: M4 scope, commands, behavior evidence, and residual risks.

Modify these files:

- `pnpm-lock.yaml`: workspace dependency metadata after registering the new package.
- `packages/adapters/package.json`: add the workspace observation dependency.
- `packages/adapters/src/types.ts`: add observer options, workspace root/context, derived coverage, and diagnostics to the proxy API.
- `packages/adapters/src/mcp-proxy.ts`: orchestrate before/after observation, effect persistence, out-of-band events, and completion effect IDs.
- `packages/adapters/test/mcp-proxy.test.ts`: add deterministic observer integration and degraded-coverage scenarios while preserving M3 assertions.
- `docs/implementation/phase1/PHASE_1_MILESTONES.md`: mark M4 complete and link its evidence.
- `docs/ROADMAP.md`: update Phase 1 current status and M4 status.
- `docs/ARCHITECTURE.md`: update the implemented-status banner and describe the M4 observation boundary.

## Shared Interfaces

Task 1 defines these exact interfaces for later tasks:

```ts
export interface ObservationContext {
  readonly workspaceRoot: string;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
}

export interface ObservedFileState {
  readonly contentHash: string;
  readonly gitBlob: string | null;
  readonly fileKind: "file" | "directory" | "symlink";
}

export interface ObservationSnapshot {
  readonly repository: {
    readonly commonDirectory: string | null;
    readonly revision: string | null;
  };
  readonly worktree: {
    readonly administrativeDirectory: string | null;
  };
  readonly files: ReadonlyMap<string, ObservedFileState>;
}

export interface ObservationGap {
  readonly kind: "bypassed" | "opaque" | "missing_sequence" | "unattributed" | "unverified";
  readonly scope: string;
  readonly reason: string;
}

export interface ObservedFileChange {
  readonly path: string;
  readonly before: ObservedFileState | null;
  readonly after: ObservedFileState | null;
  readonly changeKind: "created" | "modified" | "deleted" | "renamed";
  readonly outOfBand: boolean;
}

export interface ObservationCapture {
  readonly snapshot: ObservationSnapshot;
  readonly gaps: readonly ObservationGap[];
  readonly outOfBandChanges: readonly ObservedFileChange[];
}

export interface ObservationBoundary {
  readonly source: Source;
  captureBefore(context: ObservationContext): Promise<ObservationCapture>;
  captureAfter(context: ObservationContext): Promise<ObservationCapture>;
}

export interface DerivedCoverage {
  readonly coverageId: CoverageId;
  readonly scope: string;
  readonly modes: readonly ("intercepted" | "verified" | "inferred" | "unknown")[];
  readonly evidenceEventIds: readonly EventId[];
  readonly gaps: readonly (ObservationGap & { readonly evidenceEventIds: readonly EventId[] })[];
  readonly presentation: "sufficient" | "degraded" | "unknown";
}
```

The adapter will use `diffSnapshots(before, after, opaque)` and
`deriveCoverage({ ... })` from the observation package. `McpProxyResult<T>` will add
`coverage: DerivedCoverage | null` and
`observationDiagnostics: readonly ObservationDiagnostic[]`; calls without an observer
return `coverage: null` and an empty diagnostics list, preserving M3 behavior.

---

### Task 1: Scaffold Observation Contracts and Pure Utilities

**Files:**
- Create: `packages/observation/package.json`
- Create: `packages/observation/tsconfig.json`
- Create: `packages/observation/src/types.ts`
- Create: `packages/observation/src/paths.ts`
- Create: `packages/observation/src/redaction.ts`
- Create: `packages/observation/src/index.ts`
- Create: `packages/observation/test/effects.test.ts`
- Modify: `packages/adapters/package.json` only after the package builds, in Task 4

**Interfaces:**
- Consumes: `@patchmesh/protocol` identity types and existing sibling package scripts.
- Produces: the shared interfaces above, `normalizeLogicalPath`, `fileResourceId`, and `sanitizeDiagnostic` for Tasks 2-4.

- [ ] **Step 1: Create the workspace package metadata and strict compiler config**

Copy the package shape from `packages/storage/package.json`, set the name to
`@patchmesh/observation`, keep it private and ESM, export `dist/index.js` and its
types, and define `build`, `typecheck`, and `test` scripts using the repository's
existing commands. Depend only on `@patchmesh/protocol`.

- [ ] **Step 2: Write failing path and redaction tests**

Add explicit tests such as:

```ts
test("normalizes a repository-relative NFC path", () => {
  assert.equal(normalizeLogicalPath("src/cafe\u0301.ts"), "src/caf\u00e9.ts");
});

for (const invalid of ["C:/repo/file.ts", "src\\file.ts", "src/../file.ts", "src//file.ts", "src/file.ts/", "src/\u0000file.ts"]) {
  test(`rejects ${JSON.stringify(invalid)}`, () => assert.throws(() => normalizeLogicalPath(invalid)));
}

test("redacts secret-shaped diagnostics", () => {
  const result = sanitizeDiagnostic("Authorization: Bearer synthetic-token-value");
  assert.equal(result.includes("synthetic-token-value"), false);
  assert.equal(result.includes("<redacted>"), true);
});
```

Run: `corepack pnpm --filter @patchmesh/observation test`

Expected: FAIL because the package and utilities do not yet exist.

- [ ] **Step 3: Implement path normalization and file resource IDs**

Implement `normalizeLogicalPath(input: string): string` with NFC normalization,
slash-only segment validation, and a repository-root-independent logical result. Add
`fileResourceId(repositoryId: RepositoryId, locator: string): ResourceId` using the
existing identity rule: SHA-256 over the canonical JSON array
`[repositoryId, "file", normalizeLogicalPath(locator)]`, prefixed as `res_` and
truncated to the 32 hexadecimal characters required by the Phase 0 schema.

- [ ] **Step 4: Implement fixed-category diagnostic redaction**

Implement `sanitizeDiagnostic(value: string): string` so it replaces bearer tokens,
API-key-shaped assignments, password assignments, authorization values, and
credential query parameters with `<redacted>`. Do not accept a caller-provided regex
or echo arbitrary command output. Return a bounded diagnostic string so a failed Git
command cannot become an unbounded API response.

- [ ] **Step 5: Run the focused utility tests**

Run: `corepack pnpm --filter @patchmesh/observation test`

Expected: PASS for path normalization, resource ID stability, invalid-path rejection,
and secret redaction.

- [ ] **Step 6: Typecheck and commit the observation contract foundation**

Run: `corepack pnpm --filter @patchmesh/observation typecheck`

Expected: PASS.

```bash
git add packages/observation
git commit -m "feat: add observation contracts and path safety"
```

### Task 2: Implement Node Filesystem and Git Observation

**Files:**
- Create: `packages/observation/src/node-observation.ts`
- Create: `packages/observation/test/node-observation.test.ts`
- Modify: `packages/observation/src/types.ts` only if the concrete capture needs a typed diagnostic field
- Modify: `packages/observation/src/index.ts` to export `NodeObservationBoundary`

**Interfaces:**
- Consumes: `ObservationBoundary`, `ObservationContext`, `ObservationCapture`, `ObservedFileState`, `normalizeLogicalPath`, and `sanitizeDiagnostic` from Task 1.
- Produces: `NodeObservationBoundary` implementing `ObservationBoundary`; it captures `git rev-parse --git-common-dir`, `git rev-parse --git-dir`, `git rev-parse HEAD`, and a deterministic workspace file map.

- [ ] **Step 1: Add failing temporary-repository observation tests**

Create a temporary repository with `git init`, configure a local test identity, add
and commit `src/example.txt`, then assert the boundary captures a non-null common
directory, administrative directory, revision, and content hash. Mutate the file and
assert the after capture has a different hash. Add an untracked file and assert it is
included. Use `rmSync` cleanup in `finally`.

Also add a linked-worktree test that asserts both contexts expose the same Git common
directory and different administrative directories. The test must compare the
caller-supplied repository/workspace/worktree IDs separately from observed Git paths;
the implementation must not derive IDs from those paths.

Run: `corepack pnpm --filter @patchmesh/observation test -- node-observation.test.ts`

Expected: FAIL because `NodeObservationBoundary` is not implemented.

- [ ] **Step 2: Implement safe filesystem enumeration and content hashing**

Walk only beneath `context.workspaceRoot`, skip `.git` administrative content, use
`lstat` so symlinks retain logical identity, normalize every emitted path, and hash
regular-file bytes with SHA-256. Record directories only when needed for a typed
observation; do not read directory contents as file effects. If a path escapes the
root, cannot be read, or has an unsupported type, omit it and return an `unverified`
gap with a sanitized fixed-category reason.

- [ ] **Step 3: Implement Git metadata capture without identity derivation**

Run Git commands with `execFile` argument arrays and no shell. Capture only normalized
metadata from `--git-common-dir`, `--git-dir`, and `HEAD`; retain `null` plus a
degraded `unverified` gap when the directory is not a Git worktree or Git is
unavailable. Do not include stdout, stderr, environment values, remote URLs, branch
names, or command arguments in the capture result.

- [ ] **Step 4: Implement `NodeObservationBoundary` and injectable source metadata**

The constructor accepts a `Source` with `kind: "watcher"` or `kind: "analyzer"` and
stores no mutable per-call attribution. `captureBefore` and `captureAfter` each build
an `ObservationCapture`; the default Node implementation returns no out-of-band
changes because snapshot polling alone cannot prove their origin. It must include an
explicit `unverified` gap when the snapshot cannot prove the complete window.

- [ ] **Step 5: Run the Node observation tests**

Run: `corepack pnpm --filter @patchmesh/observation test`

Expected: PASS for repository metadata, file hashes, untracked files, linked-worktree
metadata, Git-unavailable degradation, and path confinement.

- [ ] **Step 6: Typecheck, build, and commit the Node observer**

Run: `corepack pnpm --filter @patchmesh/observation typecheck` and
`corepack pnpm --filter @patchmesh/observation build`

Expected: PASS.

```bash
git add packages/observation
git commit -m "feat: observe filesystem and git state"
```

### Task 3: Add Deterministic Effect Diffing and Coverage Derivation

**Files:**
- Create: `packages/observation/src/effects.ts`
- Modify: `packages/observation/src/index.ts` to export `diffSnapshots` and `deriveCoverage`
- Modify: `packages/observation/test/effects.test.ts`

**Interfaces:**
- Consumes: `ObservationSnapshot`, `ObservationCapture`, `ObservedFileChange`, and `ObservationGap` from Task 1; Node snapshots from Task 2.
- Produces: `diffSnapshots(before, after, opaque): { changes: readonly ObservedFileChange[]; gaps: readonly ObservationGap[] }` and `deriveCoverage(input): DerivedCoverage` for Task 4.

- [ ] **Step 1: Write failing pure effect-diff tests**

Build snapshots directly in the test and assert deterministic results for these cases:

```ts
assert.deepEqual(diffSnapshots(before, after, false).changes, [
  { path: "created.txt", before: null, after: createdState, changeKind: "created", outOfBand: false },
  { path: "deleted.txt", before: deletedState, after: null, changeKind: "deleted", outOfBand: false },
  { path: "changed.txt", before: oldState, after: newState, changeKind: "modified", outOfBand: false },
]);
```

Add a same-content delete/create pair and assert it is paired as one deterministic
`renamed` change. Assert unchanged files produce no changes and output paths sort by
code-unit order. Assert opaque calls preserve actual changes but add exactly one
`opaque` gap.

Run: `corepack pnpm --filter @patchmesh/observation test -- effects.test.ts`

Expected: FAIL because diffing and coverage functions are not implemented.

- [ ] **Step 2: Implement deterministic snapshot comparison**

Compare the union of before and after paths. Emit `created`, `modified`, and `deleted`
facts with stable path ordering. Pair deleted and created entries with identical
content hashes as `renamed`, choosing lexicographically smallest pairs when multiple
paths match. Mark regular snapshot deltas as `outOfBand: false`; pass through any
observer-provided out-of-band changes separately without changing their attribution.

- [ ] **Step 3: Implement coverage derivation**

Implement `deriveCoverage` with these rules:

- successful before/after captures begin with `modes: ["intercepted", "verified"]`;
- opaque calls add one `opaque` gap and force `presentation: "degraded"`;
- observer gaps and out-of-band changes add their declared gaps, add `unknown` when
  verification is incomplete, and force degraded presentation;
- `unattributed` or `bypassed` changes never become verified call effects;
- no gaps yields `presentation: "sufficient"`;
- a coverage ID is deterministic SHA-256 over the canonical scope, sorted modes, gap
  kinds/scopes/reasons, and evidence event IDs, prefixed `coverage_` and truncated to
  32 hexadecimal characters.

Keep raw observer errors out of the coverage result; use sanitized fixed reasons.

- [ ] **Step 4: Add coverage and rename edge-case assertions**

Assert sufficient normal coverage, degraded opaque coverage, degraded failed-capture
coverage, out-of-band nullable-attribution requirements, deterministic coverage IDs,
and no accidental `inferred` mode when only snapshot verification exists.

- [ ] **Step 5: Run the pure observation suite and commit**

Run: `corepack pnpm --filter @patchmesh/observation test` and
`corepack pnpm --filter @patchmesh/observation typecheck`

Expected: PASS.

```bash
git add packages/observation
git commit -m "feat: derive file effects and coverage"
```

### Task 4: Integrate Observation with `McpProxy`

**Files:**
- Modify: `packages/adapters/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/adapters/src/types.ts`
- Modify: `packages/adapters/src/mcp-proxy.ts`
- Modify: `packages/adapters/src/index.ts` only if new public types need re-exporting
- Modify: `packages/adapters/test/mcp-proxy.test.ts`

**Interfaces:**
- Consumes: `ObservationBoundary`, `ObservationContext`, `ObservationCapture`, `diffSnapshots`, `deriveCoverage`, `fileResourceId`, and observation source metadata from Tasks 1-3.
- Produces: an M4-enabled `McpProxy` whose result has `coverage` and diagnostics, whose completion event contains persisted effect IDs, and whose out-of-band facts are stored as separate watcher-rooted events.

- [ ] **Step 1: Add the observation dependency and deterministic fake observer tests**

Add `@patchmesh/observation: workspace:*` to the adapter package, run
`corepack pnpm install --lockfile-only`, and update the adapter test helper with a
fake boundary that returns fixed before/after snapshots and a watcher source.

Add failing tests for:

```ts
test("persists verified effects and links them from completion", async () => {
  const result = await createProxy(store, { observer: fakeObserver }).execute(
    { ...call, operation: "edit_file", opaque: false },
    { ...context, workspaceRoot },
    executor,
  );
  const events = store.read();
  assert.deepEqual(events.map((event) => event.eventType), [
    "tool.requested", "file.changed", "tool.completed",
  ]);
  assert.deepEqual(completion.payload.effectEventIds, [effect.eventId]);
  assert.deepEqual(result.coverage?.modes, ["intercepted", "verified"]);
});
```

Also add tests for failed/interrupted execution with post-call effects, opaque degraded
coverage, observer failure that still executes and persists completion, effect append
failure that does not create false verified IDs, and an out-of-band change that has
`agentId: null`, `taskId: null`, a watcher source, and a separate correlation ID.

Run: `corepack pnpm --filter @patchmesh/adapters test`

Expected: FAIL because the proxy does not yet accept an observer or append effects.

- [ ] **Step 2: Extend adapter types without changing M3 lifecycle semantics**

Add optional `workspaceRoot` to `McpCallContext` so existing M3 callers remain valid
when observation is not configured. Add optional `observer` to `McpProxyOptions`, an
injectable `createCorrelationId` for out-of-band roots, and these result fields:

```ts
readonly coverage: DerivedCoverage | null;
readonly observationDiagnostics: readonly ObservationDiagnostic[];
```

An observer-less call returns `coverage: null` and no diagnostics. Keep existing event
ID, timestamp, execution, request, completion, and storage-error types intact.

- [ ] **Step 3: Implement before/after observation around execution**

After request persistence, call `captureBefore` when an observer and workspace root
are available. Catch observer errors into sanitized gaps and continue. Run the existing
executor classification unchanged. Always call `captureAfter` in a `finally`-equivalent
post-execution path, including failed and interrupted results.

- [ ] **Step 4: Implement normalized effect event creation and persistence**

For each regular `ObservedFileChange`, allocate an event ID before constructing the
event so both resource-version `evidenceEventIds` arrays can include that event ID.
Create a `file.changed` event with the observer source, request correlation, request
event as `causationId`, inherited domain/attribution, `sourceSequence: null`, and:

- `beforeVersion: null` for created files;
- `afterVersion.kind: "deleted"` and `afterVersion.value: null` for deleted files;
- `content_hash` versions for existing before/after content;
- `changeKind` from the diff fact and the existing logical file resource ID.

Append each event through `parseEvent` and the existing store. Keep only successfully
stored IDs. Append out-of-band facts separately with a new correlation ID, nullable
agent/task attribution, `causationId: null`, and the observer source; do not place
these IDs in the MCP completion effect list.

- [ ] **Step 5: Link effects into `tool.completed` and return derived coverage**

Change the completion-event helper to accept `effectEventIds`. Append completion after
effect attempts, preserving the existing completion-storage failure behavior. Build
coverage after the completion ID is known, using request/effect/out-of-band/completion
IDs as evidence. If effect persistence failed, include a sanitized observation gap and
never include that event ID.

- [ ] **Step 6: Run adapter integration and all existing adapter tests**

Run: `corepack pnpm --filter @patchmesh/adapters test`

Expected: PASS for all original M3 tests plus the new M4 effect, failure, opaque,
out-of-band, and observation-persistence scenarios.

- [ ] **Step 7: Typecheck, build, and commit the proxy integration**

Run: `corepack pnpm --filter @patchmesh/adapters typecheck` and
`corepack pnpm --filter @patchmesh/adapters build`

Expected: PASS.

```bash
git add packages/adapters pnpm-lock.yaml
git commit -m "feat: integrate effect observation with mcp proxy"
```

### Task 5: Record M4 Evidence and Update Current Documentation

**Files:**
- Create: `docs/implementation/phase1/evidence/PHASE_1_M4_EVIDENCE.md`
- Modify: `docs/implementation/phase1/PHASE_1_MILESTONES.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: verified package behavior and command output from Tasks 1-4.
- Produces: current documentation that labels M4 implemented, links exact evidence,
  and preserves the closed-event/degraded-coverage scope.

- [ ] **Step 1: Update milestone and roadmap status text**

Change the Phase 1 milestone status from “M0, M1, M2, and M3 complete; M4-M7 planned”
to “M0 through M4 complete; M5-M7 planned”, link the M4 exit evidence, and mark the
M4 status in `docs/ROADMAP.md`. Update only current-status statements; do not rewrite
historical M3 evidence or pull M5 projection behavior forward.

- [ ] **Step 2: Update architecture current-capability text**

Change the architecture banner to state that M4 effect observation is implemented and
add a paragraph after the M3 boundary description explaining that M4 captures Git,
filesystem, hashes, and process outcomes, persists normalized file effects, and returns
derived degraded coverage without adding a coverage event or policy behavior.

- [ ] **Step 3: Write the M4 evidence document**

Record the verification date, implementation base commit, scope, exact commands and
results, and behavior evidence for:

- created/modified/deleted/renamed file effects and content hashes;
- Git repository/worktree/revision observation and linked-worktree identity behavior;
- failed and interrupted process outcomes;
- opaque shell degraded coverage;
- observer and effect persistence failures;
- out-of-band nullable-attribution events;
- secret redaction and path safety;
- no new event type, detector, finding, decision, directive, or AST analysis.

List residual risk explicitly: snapshot windows cannot prove arbitrary bypass origin,
opaque commands are not prospectively enumerable, ignored/external paths may remain
unverified, and coverage is derived until M5 projection work.

- [ ] **Step 4: Run Markdown hygiene checks and commit documentation**

Run: `git diff --check`

Expected: PASS with no whitespace errors.

```bash
git add docs/implementation/phase1/evidence/PHASE_1_M4_EVIDENCE.md docs/implementation/phase1/PHASE_1_MILESTONES.md docs/ROADMAP.md docs/ARCHITECTURE.md
git commit -m "docs: record M4 effect observation evidence"
```

### Task 6: Run the Full M4 Verification Gate

**Files:**
- Modify only files required to fix verified failures; do not add unrelated cleanup.

**Interfaces:**
- Consumes: all implementation and documentation changes from Tasks 1-5.
- Produces: passing focused and repository-wide evidence, a reviewed diff, and a
  final M4 completion checkpoint.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
corepack pnpm --filter @patchmesh/observation test
corepack pnpm --filter @patchmesh/adapters test
```

Expected: both packages pass, including temporary repository, linked-worktree,
redaction, degraded coverage, and effect-linking scenarios.

- [ ] **Step 2: Run workspace tests, typechecks, and builds**

Run:

```bash
corepack pnpm --recursive test
corepack pnpm --recursive typecheck
corepack pnpm --recursive build
```

Expected: all workspace packages pass with no TypeScript errors or build failures.

- [ ] **Step 3: Run the Phase 0 compatibility gate**

Run:

```bash
node tools/phase0/validate.mjs
node --test tools/phase0/*.test.mjs
```

Expected: `Phase 0 corpus valid` and all Phase 0 tests pass. M4 must not alter Phase 0
schemas, fixtures, validator behavior, or closed protocol vocabulary.

- [ ] **Step 4: Review the diff and repository status**

Run:

```bash
git diff --check
```

Expected: only M4 implementation, tests, lockfile, evidence, and current-status docs
are present; no secrets, generated `dist` changes, unrelated refactors, or whitespace
errors appear.

- [ ] **Step 5: Record the verified completion checkpoint**

Update the manual task checkpoint with the final command results and affected paths,
then finish the task only after all commands above pass. The final report must state
any residual snapshot/bypass limitations and must not claim coverage completeness.

---

## Plan Self-Review

- **Spec coverage:** the package boundary, closed event set, Git/filesystem/revision
  observation, hashes, file effects, effect IDs, derived coverage, opaque/bypass gaps,
  redaction, fail-open observation errors, security fixtures, cross-worktree behavior,
  documentation, and full verification are covered by Tasks 1-6.
- **Placeholder scan:** no step depends on unfinished placeholders, unspecified error
  handling, or an undefined neighboring interface.
- **Type consistency:** Task 1 defines the observation interfaces; Task 2 implements
  the boundary; Task 3 consumes snapshots and produces diff/coverage functions; Task 4
  consumes those exact names and adds them to the proxy result; Tasks 5-6 consume the
  verified behavior.
- **Scope check:** this remains one M4 vertical slice. The observation package and
  proxy integration are sequentially dependent, not independent product subsystems;
  splitting them into separate specs would weaken the end-to-end exit evidence.
