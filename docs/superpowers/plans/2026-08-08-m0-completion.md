# M0 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Phase 1 M0 prerequisite gate with explicit, reproducible, committed Phase 0 evidence while keeping all Phase 1 runtime work out of scope.

**Architecture:** Reuse the existing language-neutral Phase 0 validator, corpus, schemas, fixtures, and Node tests. Add a human-readable evidence record and reconcile the existing roadmap and repair-plan status; do not add a TypeScript workspace or runtime modules.

**Tech Stack:** Markdown documentation, Node.js built-in test runner, existing Phase 0 validator, Git, PowerShell 7.

## Global Constraints

- M0 is a prerequisite gate, not a Phase 1 runtime milestone.
- No TypeScript or pnpm workspace, runtime adapter, gateway, SQLite store, projection engine, daemon, or CLI may be added.
- Phase 1 remains planned and report-only; no Phase 2 findings, directives, or enforcement behavior may be introduced.
- The final gate artifacts must be committed, and verification must be repeated from the committed tree.
- Run `node tools/phase0/validate.mjs` before the completion commit.

---

### Task 1: Add the M0 Evidence Record

**Files:**
- Create: `docs/PHASE_0_M0_EVIDENCE.md`

**Interfaces:**
- Consumes: Existing Phase 0 validator, tests, schemas, fixtures, benchmarks, and tracked-path boundary.
- Produces: A stable evidence record linked from the M0 milestone.

- [ ] **Step 1: Write the evidence record**

Include the M0 scope, verification date, `HEAD` revision command, exact commands, observed results, fixture and redaction coverage, placeholder/link/JSON hygiene, forbidden Phase 1 path check, and the statement that no Phase 1 runtime is implemented.

Use these exact verification commands in the record:

```powershell
node tools/phase0/validate.mjs
node --test tools/phase0/*.test.mjs
git ls-files -- package.json pnpm-workspace.yaml 'apps/**' 'packages/**'
git diff --check
git rev-parse --verify HEAD
```

Document that the path-list command must produce no output and that the remaining commands must succeed.

- [ ] **Step 2: Review the evidence record for unsupported claims**

Confirm every result is backed by one of the listed commands or by the validator/test assertions. Do not claim Phase 1 runtime behavior, performance measurements, or a clean worktree before the final verification task.

### Task 2: Mark M0 Complete Without Advancing Phase 1

**Files:**
- Modify: `docs/PHASE_1_MILESTONES.md:3-60`
- Modify: `docs/ROADMAP.md:71-97`

**Interfaces:**
- Consumes: `docs/PHASE_0_M0_EVIDENCE.md`.
- Produces: Consistent roadmap and milestone status showing only the M0 prerequisite is complete.

- [ ] **Step 1: Update the milestone status**

Change the milestone document status from planned to a precise statement that M0 is complete and M1 through M7 remain planned. Mark the M0 heading or scope with `Complete` and link its exit evidence to `docs/PHASE_0_M0_EVIDENCE.md`.

- [ ] **Step 2: Add the roadmap M0 prerequisite status**

Add a short M0 prerequisite line to the Phase 1 roadmap section linking the evidence record. Keep the Phase 1 goal, deliverables, and exit gates unchanged and do not mark Phase 1 complete.

- [ ] **Step 3: Check documentation consistency**

Confirm `docs/CLI.md` still says Phase 1 commands are planned and that no canonical document claims a released runtime.

### Task 3: Reconcile the Phase 0 Repair Plan

**Files:**
- Modify: `docs/superpowers/plans/2026-08-07-phase-0-validator-repair.md:1034-1111`

**Interfaces:**
- Consumes: The completed validator-repair checklist and the M0 evidence record.
- Produces: A plan history that records the explicit user-authorized completion commit instead of leaving the old “no commit” constraint contradictory.

- [ ] **Step 1: Add the M0 reconciliation note**

Append a dated reconciliation section stating that the Phase 0 corpus, validator, tests, fixture checks, and hygiene checks satisfy the M0 gate, and link to `docs/PHASE_0_M0_EVIDENCE.md`.

- [ ] **Step 2: Correct the commit constraint**

Replace the final “No commit unless explicitly requested” non-goal with a historical note that no commit was made during repair until the user explicitly authorized the M0 completion commit. Do not rewrite the earlier repair-task history.

### Task 4: Verify the Gate From the Committed Tree

**Files:**
- Verify: `docs/PHASE_0_M0_EVIDENCE.md`
- Verify: all files referenced by the M0 evidence record

**Interfaces:**
- Consumes: All Tasks 1–3 artifacts.
- Produces: Verified commit-ready M0 evidence and no Phase 1 runtime surface.

- [ ] **Step 1: Run the validator and full Phase 0 tests**

Run:

```powershell
node tools/phase0/validate.mjs
node --test tools/phase0/*.test.mjs
```

Expected: the validator prints `Phase 0 corpus valid` and all tests pass.

- [ ] **Step 2: Run repository hygiene and boundary checks**

Run:

```powershell
git ls-files -- package.json pnpm-workspace.yaml 'apps/**' 'packages/**'
git diff --check
```

Expected: the forbidden-path command produces no output and `git diff --check` exits successfully.

- [ ] **Step 3: Review the exact diff and stage only intended M0 artifacts**

Run:

```powershell
git status --short
git diff --stat
git diff -- docs/PHASE_1_MILESTONES.md docs/ROADMAP.md docs/superpowers/plans/2026-08-07-phase-0-validator-repair.md docs/PHASE_0_M0_EVIDENCE.md
```

Do not stage unrelated user changes. Confirm the diff contains no runtime scaffolding or secret material.

- [ ] **Step 4: Commit the M0 gate artifacts**

Run:

```powershell
git add -- docs/PHASE_0_M0_EVIDENCE.md docs/PHASE_1_MILESTONES.md docs/ROADMAP.md docs/superpowers/plans/2026-08-07-phase-0-validator-repair.md docs/superpowers/plans/2026-08-08-m0-completion.md docs/superpowers/specs/2026-08-07-phase-0-validator-repair-design.md
git commit -m "docs: complete M0 phase 0 gate"
```

- [ ] **Step 5: Re-run verification after the commit**

Run the validator, full tests, forbidden-path check, `git diff --check`, and `git status --short --branch` again. Record the final commit revision with `git rev-parse --verify HEAD` and confirm the committed tree is clean apart from unrelated pre-existing changes, if any.

### Task 5: Final Review

**Files:**
- Review: `docs/PHASE_0_M0_EVIDENCE.md`
- Review: `docs/PHASE_1_MILESTONES.md`
- Review: `docs/ROADMAP.md`
- Review: `docs/superpowers/plans/2026-08-07-phase-0-validator-repair.md`

- [ ] **Step 1: Confirm M0 acceptance criteria**

Confirm the evidence record is accurate, all checks pass, positive and negative fixture expectations are validated, no Phase 1 runtime paths are tracked, M0 is marked complete, M1 through M7 remain planned, and the M0 artifacts are committed.

- [ ] **Step 2: Report residual scope clearly**

Report that Phase 1 runtime observation, storage, projections, adapters, daemon, and CLI remain unimplemented and are the next planned work after M0.
