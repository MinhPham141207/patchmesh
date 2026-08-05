# PatchMesh CLI Roadmap Alignment Design

**Status:** Approved direction, awaiting written-spec review

**Date:** 2026-08-06

## Context

`docs/CLI.md` was added as a target CLI reference after the roadmap and canonical
architecture contracts were defined. It currently mixes scheduled MVP commands,
unscheduled support commands, and deferred capabilities in one apparent MVP surface.
Several examples also imply semantic duplicate detection, ownership arbitration, and
global cross-worktree versions that conflict with the report-only roadmap.

`docs/ROADMAP.md` is authoritative for scope and build order. This change aligns the
CLI reference to it without expanding or reinterpreting the roadmap.

## Goals

1. Make command phase and availability explicit.
2. Restore the Phase 1 and Phase 2 command ordering defined by the roadmap.
3. Keep MVP examples deterministic and report-only.
4. Use canonical version-domain, task-validity, action, directive, attribution, and
   coverage terminology.
5. Preserve useful unscheduled command designs without presenting them as committed
   roadmap work or implemented behavior.
6. Expose roadmap acceptance requirements whose CLI interaction is not yet designed.

## Non-Goals

- Changing `docs/ROADMAP.md` or pulling capabilities into an earlier phase.
- Implementing the CLI or choosing a CLI framework.
- Finalizing protocol schemas beyond fields already required by canonical documents.
- Designing claims, leases, hard enforcement, semantic duplicate detection, or a
  dashboard.
- Inventing commands for unresolved Phase 2 feedback or Phase 3 validity workflows.

## Approaches Considered

### 1. Phase matrix plus targeted corrections — selected

Add an authoritative phase/availability matrix, annotate command sections, add the
missing Phase 1 `graph` reference, and correct conflicting examples and output rules.

This keeps useful design material while making roadmap commitments unambiguous.

### 2. Remove every command not named by the roadmap

Reduce the document to `status`, `agents`, `events`, `graph`, `overlaps`, `stale`,
and `explain`.

This is maximally strict but discards useful support-command design and makes future
CLI work repeat discovery already captured in the reference.

### 3. Rewrite the reference entirely around roadmap phases

Reorder every section into Phase 1 through Phase 5 chapters.

This is clear but creates a large editorial diff and couples long-lived command
reference structure too closely to a roadmap that will evolve.

## Command Scope and Availability

The CLI reference will begin with a prominent status statement:

- PatchMesh has no released implementation.
- Every command is a planned target until implementation and tests exist.
- Roadmap placement means scheduled scope, not availability.
- Unscheduled commands require a roadmap update before implementation.

It will then classify commands as follows:

| Classification | Commands | Treatment |
| --- | --- | --- |
| Phase 1 — Observe and Replay | `status`, `agents`, `events`, `graph` | Scheduled, report-only target commands |
| Phase 2 — Deterministic Detection | `overlaps`, `stale`, `explain` | Scheduled after Phase 1 gates |
| Unscheduled support designs | `init`, `start`, `stop`, `follow`, `inspect`, `doctor` | Retained as target designs, not MVP commitments |
| Deferred dashboard design | `watch` | Removed from the primary/first-run workflow and explicitly deferred |
| Later or unscheduled concepts | `replay`, `claims`, `tasks`, `adapters`, `config`, `export`, `benchmark` | Kept in a clearly non-available catalog with known roadmap constraints |

`graph` will no longer appear in the generic planned-command list. It will receive a
minimal Phase 1 reference section for read-only work-graph projection inspection.

The runnable-looking `init -> start -> watch` workflow will be removed. Until support
commands are scheduled and implemented, the document will describe the planned Phase
1 evidence workflow (`status`, `events`, and `graph`) rather than a first-run recipe.

## Report-Only Example Corrections

The overlap example will be limited to deterministic evidence:

- finding type `same_symbol_overlap`;
- a stable finding ID and decision ID;
- evidence that two agents touched or intended to touch the same symbol;
- coordination action `request_recheck` or `notify`;
- gateway directive `allow_with_notice`;
- no ownership assignment, retained claim, delay, or rejection.

`duplicate` and `conflicting` may remain documented only as deferred classification
concepts, not active MVP overlap types. The live-view example will not claim semantic
“work convergence” detection.

Exit code `7` will be labeled as reserved for Phase 4 policy enforcement and
unavailable to Phase 0 through Phase 3 gateway decisions.

## Canonical State and Version Output

Agent inspection output will separate:

- `Agent status`, using the agent lifecycle vocabulary;
- `Task validity`, using `completed`, `possibly_stale`, `revalidating`, `valid`, or
  `stale` where applicable.

Cross-worktree examples will replace bare `readVersion`/`currentVersion` comparisons
with:

- repository and workspace/worktree version domains;
- the observed version used by the affected task;
- the candidate version proposed in another worktree;
- the named integration target against which prospective impact is evaluated.

Human and JSON decision output will separately expose:

- finding and decision IDs;
- coordination action;
- gateway directive;
- evidence and dependency path;
- observability coverage;
- `taskId: null` when attribution is unknown.

The JSON example will include a schema version but will remain illustrative rather
than claiming a finalized wire schema.

## Coverage, Redaction, and Exit Behavior

Phase 1 status and diagnostic examples will report observability coverage and bypass
or opaque-operation limitations without implying complete observation.

All human, JSON, NDJSON, and `--raw` output remains redacted. “Raw” means minimally
formatted normalized payloads, never unredacted payloads.

Reporting a degraded state remains a successful report and exits `0`. Exit code `8`
is reserved for a command that cannot complete its requested operation because the
required observability is unavailable.

## Undesigned Acceptance Interactions

The CLI reference will explicitly list roadmap requirements that need a later CLI
interaction design instead of silently omitting them or inventing commands:

- Phase 2 finding dismissal and notification-usefulness recording;
- Phase 3 validity history and recommended-check views;
- Phase 3 revalidation result linkage and proof for confirmed stale status.

These notes are design obligations, not available commands.

## Files and Scope

Implementation will change:

- `docs/CLI.md` for all user-facing alignment corrections;
- the implementation plan produced after this design is approved.

`docs/ROADMAP.md`, README, architecture, lifecycle, terminology, and agent rules will
remain unchanged unless verification reveals a direct link or wording dependency.

## Verification

The implementation will be checked by:

1. comparing every scheduled command against its roadmap phase;
2. scanning MVP examples for deferred semantic, ownership, delay, and rejection
   behavior;
3. checking version examples for a version domain and integration target;
4. checking agent status, task validity, coordination action, and gateway directive
   labels against canonical terminology;
5. checking coverage, nullable attribution, stable IDs, and universal redaction;
6. verifying all repository-local Markdown links;
7. running placeholder and whitespace checks;
8. reviewing the final diff for unrelated changes.

## Success Criteria

The alignment is complete when a reader can determine, without inference:

- which commands are scheduled for each roadmap phase;
- which designs are unscheduled or deferred;
- that no CLI command is currently implemented;
- that MVP decisions remain deterministic and report-only;
- how cross-worktree versions, task validity, actions, directives, and coverage appear
  in CLI output;
- which roadmap acceptance interactions still require a dedicated design.
