# Phase 2 Golden Scenario Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a real MCP-proxy operation in two linked Git worktrees produce watcher-confirmed sufficient coverage and a deterministic same-symbol finding.

**Architecture:** Add optional structured effect metadata to successful tool results. The adapter persists the exact watcher `file.changed` event IDs that match that metadata on `tool.completed`; protocol validation and graph projection accept watcher effects as sufficient only through those durable IDs. A real temporary-Git integration test exercises the complete path without injecting protocol events or weakening unmatched snapshot coverage.

**Tech Stack:** Strict TypeScript, Node `node:test`, `@patchmesh/adapters`, `@patchmesh/observation`, `@patchmesh/storage`, `@patchmesh/core`, SQLite event store, and Git CLI temporary linked worktrees.

## Global Constraints

- Snapshot-only, opaque, failed, interrupted, mismatched, and out-of-band effects remain degraded.
- Watcher events remain watcher-sourced; no source relabeling is allowed.
- The integration test must mutate real files in real temporary linked worktrees through `McpProxy` and `NodeObservationBoundary`.
- Existing unit and integration tests must continue passing.
- Existing V1 tool-completion events remain valid when the new attribution field is absent.

---

### Task 1: Extend the completion contract

**Files:**
- Modify: `packages/adapters/src/types.ts`
- Modify: `packages/protocol/src/events.ts`
- Modify: `schemas/phase0/v1/event-payloads.schema.json`
- Modify: `packages/protocol/src/validation.ts`
- Modify: `docs/protocol/events.md`
- Test: `packages/protocol/test/protocol.test.ts`

**Interfaces:**
- Add optional successful execution metadata: `effectResourceIds?: readonly ResourceId[]`.
- Add optional `ToolCompletedPayload.deterministicallyAttributedEffectEventIds?: readonly EventId[]`.
- Validate each durable deterministic-attribution ID as an existing, watcher-sourced `file.changed` event that is also listed in `effectEventIds` and shares the completion's repository, workspace, worktree, correlation, and task attribution.

- [ ] **Step 1: Add a failing protocol test**

Add a valid `tool.completed` fixture containing `deterministicallyAttributedEffectEventIds` and assert `parseEvent` accepts it. Add a negative event whose deterministic ID references a non-`file.changed` effect and assert `validateEventSet` rejects it with `PHASE0_SCHEMA_INVALID`.

- [ ] **Step 2: Run the focused protocol test**

Run: `corepack pnpm --filter @patchmesh/protocol test`

Expected: the new positive case fails because the payload type/schema does not yet define the field; the negative case fails because no semantic guard exists.

- [ ] **Step 3: Implement the contract and semantic validation**

Add the optional schema property with `uniqueItems: true`, extend the TypeScript payload type, and add completion validation that checks the durable references against `eventsById`, `effectEventIds`, event type/source, and envelope domain/attribution.

- [ ] **Step 4: Run the focused protocol tests**

Run: `corepack pnpm --filter @patchmesh/protocol test`

Expected: all protocol tests pass, including the new acceptance and rejection cases.

### Task 2: Persist and project deterministic watcher attribution

**Files:**
- Modify: `packages/adapters/src/mcp-proxy.ts`
- Modify: `packages/storage/src/work-graph-coverage.ts`
- Test: `packages/adapters/test/mcp-proxy.test.ts`
- Test: `packages/storage/test/work-graph.test.ts`

**Interfaces:**
- `createToolCompletedEvent` accepts deterministic effect event IDs and includes the optional payload field only when non-empty.
- `McpProxy` compares successful `effectResourceIds` with the exact intercepted watcher changes. It emits deterministic IDs only for a non-opaque success with a non-empty exact match, no out-of-band changes, and no observation gaps other than the known snapshot-origin gap.
- `deriveProjectionCoverage` suppresses the watcher-origin gap only for watcher `file.changed` events listed in the validated completion field. Unlisted watcher effects remain degraded.

- [ ] **Step 1: Add focused failing assertions**

Extend the adapter test to execute a real observed change with `effectResourceIds` and assert the completion contains the deterministic file-change event ID and the returned coverage is sufficient. Add a storage test proving a watcher effect without the durable field remains degraded and the same effect with the valid field is sufficient.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `corepack pnpm --filter @patchmesh/adapters test -- mcp-proxy.test.ts` and `corepack pnpm --filter @patchmesh/storage test -- work-graph.test.ts`

Expected: the new assertions fail because the execution result has no effect metadata path and the projection always flags watcher effects.

- [ ] **Step 3: Implement the minimal proxy attribution path**

Add deterministic resource-ID matching, preserve the raw watcher events, filter only the known snapshot-origin gap from adapter-derived coverage for an exact match, and pass the matched file-change event IDs into `tool.completed`. Leave every mismatch and all other gaps degraded.

- [ ] **Step 4: Implement projection support**

When calculating tool coverage, read the validated deterministic IDs from `tool.completed`; skip the watcher-origin gap only for matching watcher file-change events. Keep the existing gap for all other watcher effects.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run: `corepack pnpm --filter @patchmesh/adapters test -- mcp-proxy.test.ts` and `corepack pnpm --filter @patchmesh/storage test -- work-graph.test.ts`

Expected: focused adapter and storage tests pass, including the existing degraded watcher tests.

### Task 3: Add the real linked-worktree Phase 2 golden test

**Files:**
- Modify: `tools/phase1/package.json`
- Create: `tools/phase1/phase2-golden.test.ts`
- Modify: `tools/phase1/tsconfig.json` only if the existing include cannot resolve the new workspace dependency

**Interfaces:**
- Consume `McpProxy`, `McpCallContext`, `McpToolCall`, `NodeObservationBoundary`, `fileResourceId`, `SqliteEventStore`, `projectWorkGraph`, and `createPhase2RuntimeRecords` from public package exports.
- Produce only events returned by the real proxy and findings/decisions created by `createPhase2RuntimeRecords`.

- [ ] **Step 1: Write the failing integration test**

Create a temporary Git repository, commit an exported TypeScript function, create two detached linked worktrees, and execute one real `edit_file` proxy call in each worktree. Each executor must write a different function signature and return `effectResourceIds: [fileResourceId(repositoryId, "src/api.ts")]`. Use watcher-source `NodeObservationBoundary`, analyzer source analysis, distinct worktree/agent/task/correlation identities, and a real SQLite store. Assert the desired sufficient coverage, durable derived events, and finding output so the test fails against the current implementation.

- [ ] **Step 2: Run the integration test to verify RED**

Run: `corepack pnpm --filter @patchmesh/phase1-tools test -- phase2-golden.test.ts`

Expected: the test fails because its desired assertions for sufficient projected coverage and a same-symbol finding are not yet met; the current implementation instead produces degraded coverage and no records.

- [ ] **Step 3: Complete the desired assertions**

Assert both tool scopes are `sufficient`, both `file.changed` and derived `symbol.changed` events are durable, `createPhase2RuntimeRecords` returns exactly one `same_symbol_overlap` record, the decision directive is `allow_with_notice`, and appending those generated records produces finding and decision views in the projected graph.

- [ ] **Step 4: Run the focused integration test**

Run: `corepack pnpm --filter @patchmesh/phase1-tools test -- phase2-golden.test.ts`

Expected: the real-worktree golden scenario passes without synthetic event fixtures.

### Task 4: Full verification and documentation review

**Files:**
- Review: `docs/superpowers/specs/2026-08-10-phase2-golden-scenario-design.md`
- Review: `docs/implementation/phase2/PHASE_2_MILESTONES.md`

- [ ] **Step 1: Run all workspace tests**

Run: `corepack pnpm test`

Expected: build succeeds and all workspace tests pass.

- [ ] **Step 2: Run recursive typecheck**

Run: `corepack pnpm typecheck`

Expected: all workspace projects typecheck successfully.

- [ ] **Step 3: Inspect the diff and whitespace**

Run: `git diff --check` and `git status --short`

Expected: only the protocol, adapter, storage, integration-test, package, schema, and approved spec/plan files are changed; no generated artifacts or unrelated edits are included.

- [ ] **Step 4: Record the verified outcome**

Update project memory with the final end-to-end result, exact verification commands, and any residual limitation without storing raw logs or temporary paths.
