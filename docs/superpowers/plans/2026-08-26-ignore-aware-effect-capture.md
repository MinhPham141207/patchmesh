# Ignore-Aware Effect Capture Implementation Plan

> **For agentic workers:** Implement inline. The change is intentionally one subsystem.

**Goal:** Prune Git-ignored paths before full observation hashes files.

**Architecture:** `packages/observation/src/node-observation.ts` obtains Git's tracked plus nonignored path set, prunes the existing recursive walker with it, and falls back to the current walk if Git cannot answer. `packages/recorder/src/ingest-bin.ts` skips effect capture when no calls were ingested, avoiding a duplicate empty lifecycle drain. No protocol or storage changes.

**Tech Stack:** TypeScript, Node built-ins, Git, Node test runner.

---

### Task 1: Regression test

**Files:**
- Modify: `packages/observation/test/node-observation.test.ts`

- [x] Add a temporary Git repository test with `ignored/` in `.gitignore`, one ignored file, and one visible file.
- [x] Run the focused test and observe the expected failure: the ignored file is currently present in the full snapshot.

### Task 2: Git-aware full capture

**Files:**
- Modify: `packages/observation/src/node-observation.ts`

- [x] Add a bounded Node-built-in Git path query using `git ls-files --cached --others --exclude-standard -z`.
- [x] Normalize returned paths and treat command failure as `null`, preserving the existing full-walk fallback.
- [x] Build candidate directory prefixes, prune directories absent from the candidate set, and skip files absent from it.
- [x] Preserve `.git`, `node_modules`, and `.evidence/runtime` exclusions, including external-link diagnostics.

### Task 3: Avoid duplicate empty-drain scans

**Files:**
- Modify: `packages/recorder/src/ingest-bin.ts`
- Create: `packages/recorder/test/ingest-bin.test.ts`

- [x] Add a regression test showing an empty ingest must not create an effect snapshot.
- [x] Return before effect capture when `ingestJournal` ingests zero calls.

### Task 4: Verification

**Files:**
- None.

- [x] Run the focused observation test: 47/47 passed.
- [x] Run the recorder regression/package test: 142/142 passed.
- [x] Run observation typecheck/build.
- [ ] Run the relevant workspace check if focused validation is clean.
- [x] Inspect `git diff --check` and the final diff for unrelated changes.
