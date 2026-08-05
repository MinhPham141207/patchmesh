# PatchMesh CLI Roadmap Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align `docs/CLI.md` with the authoritative roadmap and canonical documentation contracts without expanding roadmap scope.

**Architecture:** Keep `docs/CLI.md` as a target command catalog, but separate roadmap placement from implementation availability. Make scheduled Phase 1 and Phase 2 commands explicit, retain unscheduled designs only with clear labels, and correct examples so they are deterministic, report-only, version-domain-aware, and coverage-aware.

**Tech Stack:** Markdown, Git, PowerShell, `rg`

---

## File Map

- Modify: `docs/CLI.md` - command status, phase placement, target usage, examples,
  output safety rules, and unresolved roadmap interaction obligations.
- Reference only: `docs/ROADMAP.md` - authoritative command phases and acceptance
  requirements.
- Reference only: `docs/ARCHITECTURE.md`, `docs/LIFECYCLE.md`,
  `docs/TERMINOLOGY.md`, and `docs/AGENTS.md` - canonical version, state, action,
  directive, coverage, redaction, and documentation contracts.
- Reference only: `docs/superpowers/specs/2026-08-06-cli-roadmap-alignment-design.md`
  - approved scope and success criteria.

### Task 1: Align command status and roadmap placement

**Files:**
- Modify: `docs/CLI.md:1-50`
- Modify: `docs/CLI.md:52-669`
- Modify: `docs/CLI.md:741-806`
- Reference: `docs/ROADMAP.md:3-19`
- Reference: `docs/ROADMAP.md:55-113`

- [ ] **Step 1: Capture the current phase mismatch**

Run:

```powershell
rg -n "intended MVP|MVP Command Set|Planned Commands|patchmesh graph|patchmesh overlaps|patchmesh stale|patchmesh explain" docs/CLI.md docs/ROADMAP.md
```

Expected: `docs/CLI.md` lists `overlaps`, `stale`, and `explain` in the MVP set and
`graph` in Planned Commands, while `docs/ROADMAP.md` places `graph` in Phase 1 and the
other three commands in Phase 2.

- [ ] **Step 2: Replace the opening purpose and runnable first-run recipe**

At the top of `docs/CLI.md`, change the title to `PatchMesh CLI Target Reference` and
replace the current Purpose section through its first horizontal rule with:

````markdown
## 1. Status and Purpose

> **Status:** Planned. PatchMesh is documentation-first and has no released
> implementation.

This document describes target CLI behavior. No command is available until its
implementation, help output, and tests exist.

Roadmap placement means that a command is scheduled for a phase; it does not mean the
command is implemented. An unscheduled command requires an explicit roadmap update
before implementation.

The planned Phase 1 evidence workflow is:

```bash
patchmesh status
patchmesh events --follow
patchmesh graph
```

This is a target observation workflow, not a runnable quick start.
````

Keep the existing horizontal rule after this replacement.

- [ ] **Step 3: Add the command phase and availability matrix**

Insert this section immediately before `## 2. Global Usage`, renumbering Global Usage
to section 3:

```markdown
## 2. Command Roadmap and Availability

| Command | Roadmap placement | Availability |
| --- | --- | --- |
| `status` | Phase 1 - Observe and Replay | Planned, not implemented |
| `agents` | Phase 1 - Observe and Replay | Planned, not implemented |
| `events` | Phase 1 - Observe and Replay | Planned, not implemented |
| `graph` | Phase 1 - Observe and Replay | Planned, not implemented |
| `overlaps` | Phase 2 - Deterministic Detection | Planned, not implemented |
| `stale` | Phase 2 - Deterministic Detection | Planned, not implemented |
| `explain` | Phase 2 - Deterministic Detection | Planned, not implemented |
| `init`, `start`, `stop` | Unscheduled support designs | Not available |
| `follow`, `inspect`, `doctor` | Unscheduled support designs | Not available |
| `watch` | Deferred dashboard design | Not available |

The detailed unscheduled sections below preserve design work only. They are not MVP
commitments.
```

- [ ] **Step 4: Label every detailed command section**

Add one of these exact paragraphs directly below each command heading and before its
description:

```markdown
**Roadmap placement:** Phase 1 - Observe and Replay. Planned, not implemented.
```

Use it for `status`, `agents`, `events`, and the new `graph` section.

```markdown
**Roadmap placement:** Phase 2 - Deterministic Detection. Planned, not implemented.
```

Use it for `overlaps`, `stale`, and `explain`.

```markdown
**Roadmap placement:** Unscheduled support design. Not available.
```

Use it for `init`, `start`, `stop`, `follow`, `inspect`, and `doctor`.

For `watch`, use:

```markdown
**Roadmap placement:** Deferred dashboard design. Not available.
```

Replace `This is the main PatchMesh user interface.` with:

```markdown
This terminal dashboard concept is deferred by the current roadmap. Its presence in
this target catalog does not make it an MVP commitment.
```

- [ ] **Step 5: Add the missing Phase 1 graph command section**

Insert this complete section after `patchmesh inspect` and before Coordination
Inspection:

````markdown
---

## `patchmesh graph`

**Roadmap placement:** Phase 1 - Observe and Replay. Planned, not implemented.

Inspect the current rebuildable work-graph projection. This command is read-only;
the append-only event log remains the source of truth.

### Usage

```bash
patchmesh graph [options]
```

### Options

```text
--agent <id>      Limit the projection to one agent
--task <id>       Limit the projection to one task
--resource <id>   Limit the projection to one resource
--json            Print machine-readable output
```

### Example output

```text
WORK GRAPH

Integration target: main@4f92c1a
Coverage:           degraded
Coverage evidence:  intercepted, verified
Coverage gap:       opaque shell effects

agent:agent-b
  -> task:session-refresh
     -> symbol:src/db/pool.ts::releaseConnection
```
````

- [ ] **Step 6: Replace the duplicate command catalogs at the end**

Delete `# MVP Command Set`, its `init -> start -> watch` first-run block, and the old
`# Planned Commands` section. Replace them with:

````markdown
# Later and Unscheduled Command Concepts

The following concepts are not available and are not scheduled Phase 1 or Phase 2
commands:

```text
patchmesh replay
patchmesh claims
patchmesh tasks
patchmesh adapters
patchmesh config
patchmesh export
patchmesh benchmark
```

`claims` depends on measured enforcement. A second runtime adapter belongs to Phase
5 expansion. The remaining concepts require explicit roadmap placement before
implementation.
````

Keep the Documentation Rule section after this replacement.

- [ ] **Step 7: Verify phase placement and availability labeling**

Run:

```powershell
rg -n "Roadmap placement|Phase 1 - Observe and Replay|Phase 2 - Deterministic Detection|Unscheduled support design|Deferred dashboard design|patchmesh graph" docs/CLI.md
rg -n "MVP Command Set|init -> start -> watch|These commands should remain" docs/CLI.md
```

Expected: the first command returns the matrix, all 13 section labels, and the graph
section. The second command returns no matches.

- [ ] **Step 8: Commit the phase alignment**

```powershell
git add -- docs/CLI.md
git diff --cached --check
git commit -m "docs: align CLI commands with roadmap phases"
```

Expected: one commit modifying only `docs/CLI.md`.

### Task 2: Correct report-only, lifecycle, and version examples

**Files:**
- Modify: `docs/CLI.md` sections `patchmesh watch`, `patchmesh agents`,
  `patchmesh inspect`, `patchmesh overlaps`, and `patchmesh explain`
- Reference: `docs/ROADMAP.md:81-101`
- Reference: `docs/ARCHITECTURE.md:225-234`
- Reference: `docs/LIFECYCLE.md:24-38`
- Reference: `docs/LIFECYCLE.md:96-183`
- Reference: `docs/TERMINOLOGY.md:378-406`
- Reference: `docs/TERMINOLOGY.md:711-746`

- [ ] **Step 1: Remove deferred semantic and multi-adapter signals from MVP examples**

In the `watch` example, replace:

```text
00:03:21  patchmesh WARNING  Work convergence detected
```

with:

```text
00:03:21  patchmesh NOTICE   Same-symbol activity observed
```

In the `agents` example, keep one runtime only and show nullable task attribution:

```text
ID        RUNTIME       TASK                  STATUS
agent-a   claude-code   Fix login timeout     running
agent-b   claude-code   Add session refresh   running
agent-c   claude-code   -                     waiting
```

Add this sentence after that example:

```markdown
`-` represents unavailable task attribution; JSON output uses `"taskId": null`.
```

- [ ] **Step 2: Replace the agent inspection example with canonical state and versions**

Keep the existing `patchmesh inspect agent:agent-b` invocation, but replace its
example output with:

```text
Agent:              agent-b
Agent status:       running
Task:               session-refresh
Task validity:      possibly_stale
Repository:         repo-7
Workspace:          worktree-agent-b
Integration target: main@4f92c1a

Observed dependency:
  Resource:          symbol:src/db/pool.ts::releaseConnection
  Version domain:    repo-7/worktree-agent-b
  Observed version:  git:1a83e9b

Candidate change:
  Version domain:    repo-7/worktree-agent-a
  Candidate version: git:9c21d4e

Finding:             fnd-42
Decision:            dec-42
Coordination action: request_revalidation
Gateway directive:  allow_with_notice
Coverage:            intercepted, verified

Recommended check:
  Revalidate the session-refresh implementation against main@4f92c1a plus the
  candidate change.
```

- [ ] **Step 3: Restrict overlap types and replace ownership arbitration**

Rename `### Overlap types` to `### Phase 2 deterministic finding types` and replace
its list with:

```text
same_symbol_overlap
stale_read_before_write
exported_contract_invalidation
```

Add:

```markdown
Semantic duplicate-work and architectural-conflict classifications are deferred to
Phase 5 and are not emitted by the report-only MVP.
```

Replace the complete overlap example output with:

```text
Finding:             fnd-42
Decision:            dec-42
Severity:            high
Type:                same_symbol_overlap
Agents:              agent-a, agent-b
Shared resource:     symbol:src/db/pool.ts::releaseConnection

Evidence:
  agent-a is modifying the symbol
  agent-b requested an edit to the same symbol

Coordination action: request_recheck
Gateway directive:  allow_with_notice

Recommendation:
  agent-b should recheck its intended edit before continuing.
```

- [ ] **Step 4: Replace the explain example with separated action and directive**

Keep the existing `patchmesh explain dec-42` invocation, but replace its output with:

```text
Decision:            dec-42
Finding:             fnd-42
Target agent:        agent-b
Target task:         session-refresh
Confidence:          high
Coordination action: request_revalidation
Gateway directive:  allow_with_notice

Reason:
  Agent B used authenticate() from repo-7/worktree-agent-b at git:1a83e9b.
  Agent A proposed git:9c21d4e from repo-7/worktree-agent-a.
  Agent B is modifying a direct caller.

Integration target:
  main@4f92c1a

Dependency path:
  authenticate()
  -> login-handler.ts
  -> task:session-refresh

Coverage:
  intercepted, verified

Recommended check:
  Recheck the implementation and rerun login tests against the candidate change.
```

- [ ] **Step 5: Verify forbidden MVP semantics are gone**

Run:

```powershell
rg -n "retains ownership|Type:\s+duplicate|Work convergence detected|Current version is|\"readVersion\"|\"currentVersion\"" docs/CLI.md
rg -n "same_symbol_overlap|request_recheck|request_revalidation|allow_with_notice|Version domain|Candidate version|Integration target|Agent status|Task validity" docs/CLI.md
```

Expected: the first command returns no matches. The second returns the corrected
examples and canonical labels.

- [ ] **Step 6: Commit semantic corrections**

```powershell
git add -- docs/CLI.md
git diff --cached --check
git commit -m "docs: correct CLI report-only examples"
```

Expected: one commit modifying only `docs/CLI.md`.

### Task 3: Define coverage, JSON, redaction, and exit contracts

**Files:**
- Modify: `docs/CLI.md` sections `patchmesh status`, `patchmesh events`,
  `patchmesh doctor`, Exit Codes, Output Rules, and the command catalog footer
- Reference: `docs/ROADMAP.md:68-79`
- Reference: `docs/ROADMAP.md:94-121`
- Reference: `docs/ARCHITECTURE.md:145-163`
- Reference: `docs/ARCHITECTURE.md:513-522`
- Reference: `docs/AGENTS.md:411-418`

- [ ] **Step 1: Add Phase 1 coverage and attribution to status output**

Extend the status example after `Events recorded` with:

```text
Coverage:        degraded
Coverage modes:  intercepted, verified
Coverage gap:    opaque shell effects
Unattributed:    3 events
```

This reports degraded observation without converting it into a command failure.

- [ ] **Step 2: Make raw output universally redacted**

Change the `follow --raw` description to:

```text
--raw               Show minimally formatted, redacted normalized events
```

Change the `events --raw` description to:

```text
--raw               Show full normalized fields with secrets redacted
```

Add this paragraph immediately after the `events` option block:

```markdown
`--raw`, JSON, and newline-delimited JSON never bypass secret redaction.
```

- [ ] **Step 3: Replace the JSON example with the canonical illustrative envelope**

Replace the JSON example under Output Rules with:

```json
{
  "schemaVersion": 1,
  "findingId": "fnd-42",
  "decisionId": "dec-42",
  "agentId": "agent-b",
  "taskId": "session-refresh",
  "agentStatus": "running",
  "taskValidity": "possibly_stale",
  "integrationTarget": "main@4f92c1a",
  "coordinationAction": "request_revalidation",
  "gatewayDirective": "allow_with_notice",
  "coverage": ["intercepted", "verified"],
  "reasons": [
    {
      "dependency": "symbol:src/db/pool.ts::releaseConnection",
      "observedVersion": {
        "domain": "repo-7/worktree-agent-b",
        "value": "git:1a83e9b"
      },
      "candidateVersion": {
        "domain": "repo-7/worktree-agent-a",
        "value": "git:9c21d4e"
      }
    }
  ]
}
```

Add this sentence after the example:

```markdown
This is an illustrative CLI envelope, not a finalized protocol schema. Unknown task
attribution is represented as `"taskId": null`.
```

- [ ] **Step 4: Clarify codes 7 and 8**

Change exit-code descriptions to:

```text
7   Reserved for Phase 4 policy enforcement; unavailable in Phases 0-3
8   Required observability was unavailable, so the operation could not complete
```

Replace the warning sentence with:

```markdown
Commands that successfully report warnings or degraded coverage exit with `0`. Exit
code `8` applies only when required observability is unavailable and the requested
operation therefore cannot complete.
```

- [ ] **Step 5: Update doctor output to one adapter and explicit degraded coverage**

Replace the final two doctor warning lines with:

```text
[WARN] Direct shell access may bypass tool-level intent tracking
[WARN] Coverage is degraded: shell effects are verified after execution
```

Do not show a second runtime adapter in the MVP-oriented example.

- [ ] **Step 6: Add unresolved roadmap interaction obligations**

Insert this section before Documentation Rule:

```markdown
# Roadmap-Required CLI Design Gaps

The roadmap requires these user interactions, but their CLI shape is not yet
designed. They are obligations, not available commands:

- Phase 2: dismiss a finding and record notification usefulness.
- Phase 3: inspect validity history and recommended checks.
- Phase 3: link revalidation results to decisions and show the proof required for a
  confirmed `stale` status.

Do not invent or implement commands for these interactions without a focused design
and an explicit roadmap-compatible update to this reference.
```

- [ ] **Step 7: Verify output and acceptance contracts**

Run:

```powershell
rg -n "Coverage:|Coverage modes|Coverage gap|Unattributed|schemaVersion|taskId.*null|coordinationAction|gatewayDirective|observedVersion|candidateVersion|never bypass secret redaction|Reserved for Phase 4|Roadmap-Required CLI Design Gaps" docs/CLI.md
rg -n "full event payloads|Codex adapter is not configured|Operation was blocked by policy" docs/CLI.md
```

Expected: the first command finds every new contract. The second command returns no
matches.

- [ ] **Step 8: Commit output-contract corrections**

```powershell
git add -- docs/CLI.md
git diff --cached --check
git commit -m "docs: define CLI coverage and output contracts"
```

Expected: one commit modifying only `docs/CLI.md`.

### Task 4: Run full documentation verification

**Files:**
- Verify: `docs/CLI.md`
- Verify: canonical product documentation for local-link resolution
- Reference: `docs/superpowers/specs/2026-08-06-cli-roadmap-alignment-design.md`

- [ ] **Step 1: Verify the approved design requirements line by line**

Run:

```powershell
rg -n "Status.*Planned|Command Roadmap and Availability|Phase 1 - Observe and Replay|Phase 2 - Deterministic Detection|Unscheduled support design|Deferred dashboard design|same_symbol_overlap|allow_with_notice|Version domain|Candidate version|Integration target|Agent status|Task validity|schemaVersion|taskId.*null|Roadmap-Required CLI Design Gaps" docs/CLI.md
```

Expected: every design requirement has at least one match.

- [ ] **Step 2: Verify prohibited and stale wording is absent**

Run:

```powershell
rg -n "MVP Command Set|Work convergence detected|retains ownership|Current version is|\"readVersion\"|\"currentVersion\"|full event payloads|Codex adapter is not configured|Operation was blocked by policy" docs/CLI.md
```

Expected: no matches.

- [ ] **Step 3: Verify every repository-local Markdown link resolves**

Run:

```powershell
$docs = @(
  'README.md',
  'docs/VISION.md',
  'docs/ROADMAP.md',
  'docs/ARCHITECTURE.md',
  'docs/LIFECYCLE.md',
  'docs/TERMINOLOGY.md',
  'docs/AGENTS.md',
  'docs/CLI.md'
)
$broken = @()
foreach ($doc in $docs) {
  $base = Split-Path -Parent (Resolve-Path -LiteralPath $doc)
  $text = Get-Content -Raw -LiteralPath $doc
  foreach ($match in [regex]::Matches($text, '\[[^\]]+\]\(([^)]+)\)')) {
    $target = $match.Groups[1].Value.Split('#')[0]
    if (!$target -or $target -match '^(https?|mailto|skill):') { continue }
    $resolved = Join-Path $base $target
    if (!(Test-Path -LiteralPath $resolved)) { $broken += "$doc -> $target" }
  }
}
if ($broken.Count) { $broken; exit 1 }
'All local Markdown links resolve.'
```

Expected: `All local Markdown links resolve.` and exit code `0`.

- [ ] **Step 4: Verify placeholders, whitespace, and scope**

Run:

```powershell
rg -n "TBD|TODO|FIXME|PLACEHOLDER|XXX" docs/CLI.md
git diff --check 45ac6c8..HEAD
git status --short
git log -5 --oneline
```

Expected: no placeholder matches, no whitespace errors, a clean working tree, and the
three implementation commits above the plan and design commits.

- [ ] **Step 5: Review the final diff against the approved spec**

Run:

```powershell
git diff 45ac6c8..HEAD -- docs/CLI.md
```

Expected: only roadmap alignment, canonical example, coverage, redaction, exit-code,
and acceptance-gap documentation changes. If verification reveals a defect, correct
only that defect and commit it as:

```powershell
git add -- docs/CLI.md
git commit -m "docs: reconcile CLI roadmap alignment"
```
