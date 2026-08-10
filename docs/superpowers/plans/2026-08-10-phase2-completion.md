# Phase 2 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 2's report-only detector, evidence, quality, performance, and protocol gates using durable provenance and reviewed real-agent evidence without weakening degraded-coverage guards.

**Architecture:** Implement the requested order as independently testable increments. M5 starts with pure cross-worktree dependency matching, multi-consumer retention, and a deterministic signature classifier; M2 then makes the provenance required by M5 durable and replayable; M5 runtime acceptance follows from that evidence layer. M4/M6 extend scenario and CLI coverage, M7 consumes only human-reviewed real-agent cases, and M0 records a separate `NodeObservationBoundary` budget decision. The event log remains authoritative, analyzers remain pure, and all Phase 2 output remains report-only.

**Tech Stack:** Strict TypeScript, Node `node:test`, JSON Schema, `@patchmesh/analyzers`, `@patchmesh/protocol`, `@patchmesh/adapters`, `@patchmesh/core`, `@patchmesh/storage`, `@patchmesh/query`, `@patchmesh/daemon`, `@patchmesh/cli`, SQLite replay, real temporary Git repositories, and the dependency-free `.evidence` recorder.

## Global Constraints

- Gateway directives remain `allow` or `allow_with_notice`.
- Unsupported, opaque, bypassed, mismatched, failed, and unobserved operations remain degraded.
- No inferred effect becomes verified without durable observation evidence.
- V1 event streams remain replayable; new provenance uses a versioned Phase 2 V2 extension.
- Analyzer functions remain pure and side-effect free; adapters only observe and append facts.
- Do not use current filesystem state during replay to reconstruct historical detector inputs.
- Do not store prompts, hidden reasoning, credentials, tokens, cookies, private keys, or complete environment maps.
- The current `.evidence` traces have zero verified effect coverage and must not be labeled as detector positives or negatives.
- Do not modify the existing unrelated `.evidence` implementation or the current stale-read working-tree changes outside the scoped task.
- Do not add enforcement, targeted revalidation execution, dashboards, graph tables, queues, or new runtime adapters.

---

### Task 1: M5 Pure Cross-Worktree Dependencies and Compatibility

**Files:**
- Create: `packages/analyzers/src/contract-compatibility.ts`
- Modify: `packages/analyzers/src/contract-dependency-resolver.ts`
- Modify: `packages/analyzers/src/index.ts`
- Test: `packages/analyzers/test/contract-compatibility.test.ts`
- Test: `packages/analyzers/test/contract-dependency-resolver.test.ts`

**Interfaces:**
- Produce `classifyContractCompatibility(before: string, after: string): "compatible" | "breaking" | "unknown"`.
- Preserve `resolveLocalContractDependencies(facts)` but match repository, workspace, integration target, contract resource identity, and exported name without requiring equal worktrees.
- Return every `ResolvedContractDependency`; never collapse multiple consumers for one contract.
- Return no dependency for unsupported, ambiguous, bare, missing, or cross-target imports.

- [ ] **Step 1: Add failing compatibility tests.**

Add cases for unchanged signatures, additive optional/default-compatible changes, removed exports/parameters, changed parameter types, malformed signatures, and unsupported syntax. Assert unknown cases are not breaking.

- [ ] **Step 2: Run the analyzer tests to verify RED.**

Run: `corepack pnpm --filter @patchmesh/analyzers test`

Expected: the new compatibility import or assertions fail because no classifier exists and cross-worktree matching is still rejected.

- [ ] **Step 3: Implement the pure classifier.**

Normalize the supported declaration strings deterministically, classify only the explicitly supported TypeScript/JavaScript declaration forms, and return `unknown` for anything the classifier cannot prove. Do not use semantic inference or filesystem access.

- [ ] **Step 4: Add cross-worktree and multiple-consumer resolver regressions.**

Create producer and consumer facts with the same repository/workspace/integration target but different worktrees and assert both consumers resolve. Add two consumers importing the same exported symbol and assert both are returned. Keep existing bare, missing, ambiguous, and cross-target rejection tests.

- [ ] **Step 5: Implement the minimal resolver change and run the focused tests.**

Remove only the same-worktree requirement, retain repository and integration-target guards, preserve deterministic sorting, and run `corepack pnpm --filter @patchmesh/analyzers test`.

Expected: all analyzer tests pass and unresolved/unsupported paths remain degraded or empty.

### Task 2: M5 Core History and Multi-Consumer Detector Inputs

**Files:**
- Modify: `packages/core/src/same-symbol-runtime.ts`
- Modify: `packages/core/src/exported-contract-invalidation.ts`
- Modify: `packages/core/src/detector-runner.ts`
- Test: `packages/core/test/exported-contract-invalidation.test.ts`
- Test: `packages/core/test/same-symbol-runtime.test.ts`

**Interfaces:**
- Replace single-consumer contract maps with `Map<ResourceId, readonly ConsumerContractDependencyEvidence[]>` semantics.
- Preserve finding IDs, evidence ordering, confidence, and report-only policy output.
- Do not classify or report a contract without sufficient coverage and durable history inputs.

- [ ] **Step 1: Add a failing multi-consumer core test.**

Construct one breaking contract change and two consumers with the same contract resource but distinct tasks. Assert the runner returns two findings with distinct affected tasks and complete evidence paths.

- [ ] **Step 2: Add a failing history-order test.**

Provide a compatible prior contract, a breaking current contract, and an unrelated contract change in one replayable event set. Assert only the consumer of the breaking contract is selected and prior history is not confused with the unrelated resource.

- [ ] **Step 3: Run focused core tests to verify RED.**

Run: `corepack pnpm --filter @patchmesh/core test`

Expected: the multiple-consumer case produces only one result or the history case cannot identify the correct contract.

- [ ] **Step 4: Implement multi-consumer reconstruction.**

Retain all durable dependency events per contract resource, sort consumers by event ID, and run the existing detector for every compatible change/consumer pair. Keep unknown compatibility and missing-history paths suppressed.

- [ ] **Step 5: Run the core suite.**

Run: `corepack pnpm --filter @patchmesh/core test`

Expected: all existing and new tests pass with deterministic finding IDs and no gateway directives beyond report-only values.

### Task 3: M2 Durable Analyzer Provenance and V2 Contract

**Files:**
- Modify: `packages/protocol/src/events.ts`
- Modify: `packages/protocol/src/validation.ts`
- Modify: `packages/protocol/test/protocol.test.ts`
- Modify: `schemas/phase2/v1/event-envelope.schema.json`
- Create or modify: `schemas/phase2/v1/derived-evidence.schema.json`
- Modify: `packages/analyzers/src/symbol-events.ts`
- Modify: `packages/analyzers/src/dependency-events.ts`
- Modify: `packages/adapters/src/mcp-proxy.ts`
- Modify: `packages/adapters/src/types.ts`
- Test: `packages/adapters/test/mcp-proxy.test.ts`
- Test: `packages/storage/test/replay.test.ts`

**Interfaces:**
- Add a versioned derived-evidence metadata object containing analyzer ID/version, configuration digest, source event IDs, repository/workspace/worktree, integration target, coverage status/reason, stable fact identity, and normalized signature data when available.
- Validate metadata references, domains, coverage status, and source-event existence at replay.
- Persist metadata with derived symbol/dependency facts; replay must not require the adapter or current filesystem.

- [ ] **Step 1: Add failing protocol fixtures.**

Add a valid V2 derived-evidence event with complete provenance and negative fixtures for missing source events, cross-domain metadata, invalid coverage, and malformed configuration digest. Assert existing V1 events remain accepted without the optional V2 metadata.

- [ ] **Step 2: Run protocol tests to verify RED.**

Run: `corepack pnpm --filter @patchmesh/protocol test`

Expected: V2 derived-evidence fixtures fail until the schema and semantic checks exist.

- [ ] **Step 3: Implement the V2 schema, types, and validation.**

Keep the V1 event union unchanged for existing payloads. Add the new V2 event forms to the closed V2 envelope and enforce source-event/domain/correlation integrity. Reject incomplete provenance rather than downgrading it silently.

- [ ] **Step 4: Add adapter persistence regression tests.**

Run a real supported-source change through `McpProxy` and assert derived events retain analyzer version, configuration digest, integration target, source event IDs, coverage, and normalized signature data. Add a restart/replay test that reconstructs the same metadata from SQLite events without reading the changed file.

- [ ] **Step 5: Implement adapter and analyzer metadata propagation.**

Pass metadata from pure `DerivedEvidenceFacts` into durable events. Verify the captured content hash matches the event `afterVersion` before emitting source-derived facts; otherwise append the file change, record degraded coverage, and emit no symbols or dependencies.

- [ ] **Step 6: Run protocol, adapter, storage, and type checks.**

Run: `corepack pnpm --filter @patchmesh/protocol test`

Run: `corepack pnpm --filter @patchmesh/adapters test`

Run: `corepack pnpm --filter @patchmesh/storage test`

Expected: V1 compatibility, V2 validation, durable provenance, restart replay, and degraded guards all pass.

### Task 4: M5 Real Cross-Worktree Contract Golden Scenario

**Files:**
- Modify: `tools/phase1/phase2-golden.test.ts`
- Modify: `packages/adapters/test/mcp-proxy.test.ts`
- Modify: `packages/core/test/same-symbol-runtime.test.ts`
- Review: `docs/implementation/phase2/PHASE_2_MILESTONES.md`

**Interfaces:**
- Use only events emitted by real `McpProxy`, `NodeObservationBoundary`, analyzer propagation, SQLite storage, and `createPhase2RuntimeRecords`.
- Produce a reproducible exported-contract invalidation finding across two linked worktrees with at least two consumers.

- [ ] **Step 1: Add the failing real-worktree scenario.**

Create a temporary repository with an exported function and two importing consumer files. Use separate detached linked worktrees, real file mutations through `McpProxy`, distinct tasks, an explicit integration target, and structured effect metadata. Assert durable contract history, two dependency paths, and the expected report-only findings.

- [ ] **Step 2: Run the focused golden test to verify RED.**

Run: `corepack pnpm exec tsx --test tools/phase1/phase2-golden.test.ts`

Expected: the new contract assertions fail before the durable M2/M5 runtime path is wired.

- [ ] **Step 3: Wire the runtime history path.**

Use replayed durable provenance and contract history to resolve producer/consumer relationships across worktrees while retaining coverage and integration-target guards. Do not relabel watcher events or promote snapshot-only effects.

- [ ] **Step 4: Run the golden and full core/adapter/storage suites.**

Run: `corepack pnpm exec tsx --test tools/phase1/phase2-golden.test.ts`

Run: `corepack pnpm --filter @patchmesh/core test`

Run: `corepack pnpm --filter @patchmesh/adapters test`

Run: `corepack pnpm --filter @patchmesh/storage test`

Expected: same-symbol and contract golden paths pass, while opaque, failed, mismatched, out-of-band, and unsupported cases remain degraded.

### Task 5: M4 Evidence and M6 CLI/Delivery Coverage

**Files:**
- Modify: `packages/core/test/same-symbol-runtime.test.ts`
- Modify: `packages/core/test/stale-read-before-write.test.ts`
- Modify: `packages/storage/test/work-graph.test.ts`
- Modify: `apps/cli/test/cli.test.ts`
- Modify: `packages/query/test/query.test.ts`
- Modify: `apps/daemon/test/daemon.test.ts`
- Modify: `docs/CLI.md`

**Interfaces:**
- Preserve the current stale-read causal replay-order guard.
- Use public query services for CLI commands and immutable append-only daemon writers for delivery/feedback.
- Keep all output report-only and include coverage warnings.

- [ ] **Step 1: Add failing M4 regression scenarios.**

Cover current reads, pre-read versions, irrelevant resource changes, valid out-of-order event arrival, corrected attribution, bypassed/opaque operations, changed integration targets, failed executions, and incomplete observation. Assert no finding where coverage or temporal scope is insufficient.

- [ ] **Step 2: Add failing M6 CLI scenarios.**

Cover human/JSON output, agent/task/resource filters, missing attribution, degraded warnings, delivery state transitions, dismissal, usefulness feedback, and complete explanation evidence. Assert no command emits `delay`, `reject`, pause, redirect, or execution.

- [ ] **Step 3: Implement only the missing coverage and public-service paths.**

Do not change detector authority or bypass existing guards. Keep immutable event history and deterministic replay behavior intact.

- [ ] **Step 4: Run focused M4/M6 verification.**

Run: `corepack pnpm --filter @patchmesh/core test`

Run: `corepack pnpm --filter @patchmesh/storage test`

Run: `corepack pnpm --filter @patchmesh/query test`

Run: `corepack pnpm --filter @patchmesh/daemon test`

Run: `corepack pnpm --filter @patchmesh/cli test`

Expected: all evidence gaps remain visible and all directives remain non-disruptive.

### Task 6: M7 Human-Reviewed Field Corpus

**Files:**
- Create: `tools/phase2/field-corpus.schema.json`
- Create: `tools/phase2/field-corpus.json`
- Create: `tools/phase2/field-corpus.ts`
- Create: `tools/phase2/field-quality-evaluation.ts`
- Test: `tools/phase2/field-corpus.test.ts`
- Test: `tools/phase2/field-quality-evaluation.test.ts`
- Modify: `docs/implementation/phase2/PHASE_2_MILESTONES.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Require each field case to reference committed trace/event artifacts, detector type, scenario metadata, a human-reviewed expected label, reviewer ID, review timestamp, coverage classification, limitation list, replay digest, and detector output digest.
- Reject cases with unknown/unverified effects when the case claims a detector positive or negative.
- Keep `.evidence` trace-integrity cases separate from detector-quality cases.

- [ ] **Step 1: Add failing corpus validation tests.**

Reject missing reviewer metadata, missing trace/event references, duplicate case IDs, digest mismatches, synthetic-only labels, and positive/negative detector labels with zero effect coverage. Accept a complete reviewed case fixture containing real observed effects.

- [ ] **Step 2: Run the field corpus tests to verify RED.**

Run: `corepack pnpm exec tsx --test tools/phase2/field-corpus.test.ts tools/phase2/field-quality-evaluation.test.ts`

Expected: the corpus loader and evaluator are absent or reject no cases yet.

- [ ] **Step 3: Implement the versioned field corpus loader and evaluator.**

Validate committed artifacts and compute precision, recall, false-positive rate, calibration, and replay determinism per detector. Require a declared holdout split and retain raw case results. Do not mark the synthetic corpus as field evidence.

- [ ] **Step 4: Add reviewed real-agent cases only.**

Use new `.evidence` traces with actual post-tool observations and corresponding PatchMesh events. Do not convert the current zero-coverage parent/child traces into detector labels.

- [ ] **Step 5: Run the evaluator and record gate status.**

Run: `corepack pnpm exec tsx tools/phase2/field-quality-evaluation.ts`

Expected: the report distinguishes accepted field evidence from advisory synthetic evidence and names any unresolved coverage or threshold exception.

### Task 7: M0 Interception Budget and V2 Protocol Documentation

**Files:**
- Modify: `tools/phase2/engineering-gates.ts`
- Create: `tools/phase2/m0-budget-report.ts`
- Test: `tools/phase2/m0-budget-report.test.ts`
- Modify: `docs/protocol/events.md`
- Modify: `packages/protocol/test/protocol.test.ts`
- Modify: `docs/implementation/phase2/PHASE_2_MILESTONES.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Measure the actual `NodeObservationBoundary` path over declared repository-size tiers with raw samples and environment metadata.
- Emit a budget decision of `accepted`, `deferred`, or `rejected`; a deferred decision must include owner and due gate.
- Document every Phase 2 V2 event, provenance field, reference rule, replay behavior, degraded coverage rule, and report-only directive.

- [ ] **Step 1: Add failing M0 decision tests.**

Assert raw samples, p50/p95 nearest-rank calculations, workload/environment metadata, failures, and decision validation. Reject a report that accepts a recorder-only benchmark as an interception budget.

- [ ] **Step 2: Run the M0 tests to verify RED.**

Run: `corepack pnpm exec tsx --test tools/phase2/m0-budget-report.test.ts`

Expected: the budget decision/report module is absent or cannot distinguish recorder and observation workloads.

- [ ] **Step 3: Implement the actual observation benchmark report.**

Use temporary Git repositories and `NodeObservationBoundary` captures for each declared tier. Retain raw samples, failures, environment, workload definition, and a decision record without inventing acceptance thresholds.

- [ ] **Step 4: Update V2 protocol documentation and fixtures.**

Align `docs/protocol/events.md`, schemas, TypeScript event unions, validators, and tests so the documented V2 event set matches the closed validators. Preserve V1 replay compatibility and report-only limits.

- [ ] **Step 5: Run M0/docs verification.**

Run: `corepack pnpm evidence:test`

Run: `corepack pnpm exec tsx --test tools/phase2/m0-budget-report.test.ts`

Run: `corepack pnpm --filter @patchmesh/protocol test`

Expected: recorder evidence remains separate from M0, V2 docs and validators agree, and no disruptive authority is introduced.

### Task 8: Full Phase 2 Verification and Gate Update

**Files:**
- Review: `docs/superpowers/specs/2026-08-10-phase2-completion-design.md`
- Review: `docs/implementation/phase2/PHASE_2_MILESTONES.md`
- Review: `docs/ROADMAP.md`
- Review: `.evidence/trace/`
- Review: `.evidence/runs/`
- Review: `.evidence/reports/`

- [ ] **Step 1: Run the complete verification matrix.**

Run:

```text
corepack pnpm test
corepack pnpm typecheck
corepack pnpm evidence:test
corepack pnpm evidence:validate
node tools/phase0/validate.mjs
corepack pnpm exec tsx tools/phase2/detector-quality-evaluation.ts
corepack pnpm exec tsx tools/phase2/field-quality-evaluation.ts
git diff --check
git status --short
```

- [ ] **Step 2: Compare replay and projection outputs.**

Run the canonical, duplicate, reversed-arrival, restart, and golden scenarios. Confirm byte-equivalent findings, decisions, coverage, provenance, and field-corpus digests.

- [ ] **Step 3: Update milestone status only from evidence.**

Mark each milestone complete only when its exit evidence exists. Keep any advisory-only exception explicit with detector, scope, reason, owner, and expiry. Do not mark M7 complete from the synthetic evaluator or current zero-coverage `.evidence` traces.

- [ ] **Step 4: Review scope.**

Confirm the diff contains only the approved Phase 2 increments, tests, evidence artifacts, and documentation. Leave the existing unrelated `.evidence` plan and stale-read changes intact.
