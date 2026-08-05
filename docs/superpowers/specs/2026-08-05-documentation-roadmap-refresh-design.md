# PatchMesh Documentation and Roadmap Refresh Design

**Status:** Approved direction, awaiting written-spec review

**Date:** 2026-08-05

## Context

PatchMesh has a coherent product vision, architecture, lifecycle, terminology, and
agent policy, but the repository is still at the concept stage. The README is only
a title, the roadmap is empty, and several contracts are described differently
across documents. The documentation currently makes the target system sound more
implemented and settled than it is.

The refresh will preserve the core thesis: PatchMesh is a runtime consistency and
dependency-invalidation layer for parallel coding agents. It will make the first
implementable slice explicit, distinguish current repository state from target
behavior, and move unresolved protocol details into gated roadmap work.

## Goals

1. Give a new reader a useful entry point in under five minutes.
2. Turn the empty roadmap into a phased, evidence-gated delivery sequence.
3. Narrow the MVP to one local, deterministic, report-only vertical slice.
4. Reconcile version, event, confidence, action, and observability terminology.
5. State what is planned, what is deferred, and what evidence permits progression.
6. Preserve the modular-monolith, local-first, agent-agnostic architecture.

## Non-Goals

- Implementing PatchMesh code or selecting dependencies beyond the documented stack.
- Claiming that the proposed protocol or lifecycle is already implemented.
- Designing multi-tenant cloud deployment, enterprise governance, or a dashboard.
- Adding automatic semantic enforcement to the MVP.
- Replacing the root Knowl workflow or changing project-memory policy.
- Expanding PatchMesh into a task scheduler or general orchestrator.

## Approaches Considered

### 1. Minimal editorial cleanup

Populate the README and roadmap, fix the malformed terminology heading, and leave
the conceptual contracts unchanged.

This is quick but would preserve contradictions that block implementation.

### 2. Coherence pass — selected

Perform the editorial cleanup, define the MVP and phase gates, and reconcile the
small set of cross-document contracts required to make the roadmap implementable.

This produces actionable documentation without prematurely writing a complete
protocol or security RFC.

### 3. Full documentation rewrite

Replace the current set with a product requirements document, protocol RFC, threat
model, operations guide, and adapter specification.

This would over-design a product whose first end-to-end scenario has not yet been
validated.

## Documentation Architecture

### `README.md`: entry point

The README will contain:

- a one-paragraph product promise;
- an API-change invalidation example;
- current maturity and limitations;
- the first vertical slice;
- a concise architecture flow;
- links to canonical documents;
- contribution guidance pointing to `docs/AGENTS.md`.

It will explicitly state that PatchMesh is currently documentation-first and has no
released implementation.

### `docs/ROADMAP.md`: delivery contract

The roadmap will use phases with goals, deliverables, exit gates, and deferred work.
It will not use speculative calendar dates.

The phases will be:

1. **Foundation:** reconcile protocol invariants and build a golden scenario corpus.
2. **Observe and replay:** one adapter, event log, projections, coverage reporting,
   and an evidence CLI.
3. **Deterministic detection:** same-symbol overlap, stale-read-before-write, and
   exported-contract invalidation in report-only mode.
4. **Targeted revalidation:** task validity records and dependency-linked checks.
5. **Measured enforcement:** opt-in high-confidence intervention after dogfood gates.
6. **Expansion:** a second runtime adapter and selective semantic analysis only when
   measured deterministic gaps justify them.

Every phase must leave the repository in a usable, testable state. Later phases may
not begin merely because earlier code exists; their exit evidence must pass.

### `docs/VISION.md`: stable product intent

The vision will receive a concept-stage status notice, an explicit initial user, and
a sharper first promise. Broad long-term goals remain, while the initial scope is
aligned with the roadmap's deterministic report-only slice.

### `docs/ARCHITECTURE.md`: implementable target architecture

The architecture will remain a modular monolith and will clarify these contracts:

- **Version domains:** a resource version is scoped to a repository and workspace or
  worktree. A candidate change in another worktree is not a global current version.
  Impact is evaluated relative to an explicit integration target.
- **Minimum event envelope:** events include schema version, repository/workspace
  identity, correlation and causation identifiers, sequence information when the
  source provides it, and `taskId: string | null` until attribution is known.
- **Observability coverage:** evidence is classified as intercepted, verified,
  inferred, or unknown. PatchMesh never claims stronger consistency than its
  coverage supports.
- **Decision versus enforcement:** policy selects a coordination action; the gateway
  receives a separate execution directive.
- **MVP policy:** report-only by default, with no automatic pause or rejection.
- **Reliability boundary:** opaque shell operations are observational unless a
  sandbox or lower-level mediator can enforce them.

### `docs/LIFECYCLE.md`: state and transition semantics

The lifecycle will align pre-tool event recording with post-tool effect recording,
make task attribution nullable, and distinguish coordination actions from gateway
directives. It will add compact transition invariants for completed, possibly stale,
revalidating, valid, and stale work.

The MVP will only mark work `possibly_stale`; confirmation as `stale` requires a
failed validation or explicit deterministic proof.

### `docs/TERMINOLOGY.md`: canonical vocabulary

The malformed title will be corrected. The document will add or refine:

- repository, workspace/worktree, integration target, and resource version domain;
- observed, candidate, target, and integrated versions;
- dependency provenance;
- observability coverage;
- task validity record;
- coordination action versus gateway directive;
- numeric confidence with a derived policy band.

Confidence will use a normalized score from 0 to 1 when available. `low`, `medium`,
and `high` are policy-derived bands whose thresholds must be configured and recorded,
not competing representations.

### `docs/AGENTS.md`: implementation guardrails

The agent rules will:

- use correct repository-relative documentation paths;
- label planned architecture separately from implemented behavior;
- align the event envelope and action/directive terminology;
- require scenario and documentation consistency checks;
- prevent later-phase features from entering an earlier roadmap phase without an
  explicit roadmap update.

The root `AGENTS.md` and `KNOWL.md` are outside this refresh because they define the
project-memory workflow, not PatchMesh product behavior.

## Canonical Model Introduced by the Refresh

### Version model

```text
Repository
  -> workspace/worktree
     -> base revision
        -> observed resource version

Another worktree
  -> candidate resource version

Integration target
  -> target resource version
  -> prospective impact evaluation
```

`current version` may only be used with an explicit version domain. Cross-worktree
changes are prospective until integrated into the target.

### Decision and enforcement model

Policy coordination actions are:

```text
record
notify
request_recheck
assign_owner
redirect
pause
mark_possibly_stale
mark_stale
request_revalidation
create_follow_up_task
escalate
```

Gateway execution directives are:

```text
allow
allow_with_notice
delay
reject
```

For the MVP, policy actions map only to `allow` or `allow_with_notice`. `delay` and
`reject` remain disabled until the measured-enforcement phase.

### Task validity record

A task validity record contains:

- task and work-product identity;
- repository, worktree, and base revision;
- observed dependencies with versions and provenance;
- validation commands and results;
- observability coverage;
- validation timestamp;
- validity status and the decision evidence that changed it.

It is a durable explanation of why completed work is believed to be valid, possibly
stale, or stale against an integration target.

## Documentation Data Flow

The README explains the promise and routes readers to the vision and roadmap. The
roadmap defines build order and exit evidence. Architecture and lifecycle define the
target contracts for the active phase. Terminology supplies canonical names, while
agent rules constrain implementation to those contracts.

When a roadmap phase changes, affected architecture, lifecycle, terminology, and
agent-rule sections must change in the same commit.

## Handling Uncertainty

- Unimplemented behavior is labeled `planned` or `target`.
- Unresolved design choices become explicit phase deliverables, not hidden prose.
- The docs do not invent performance thresholds before a benchmark harness exists;
  they require thresholds to be measured and recorded before enforcement.
- Unsupported observation paths are reported as coverage gaps.
- Terminology conflicts are resolved in favor of `docs/TERMINOLOGY.md`.

## Verification

The documentation refresh will be checked by:

1. verifying every local Markdown link resolves;
2. scanning for placeholder markers and accidental draft text;
3. checking canonical coordination actions and gateway directives across documents;
4. checking that planned behavior is labeled and current-state claims are accurate;
5. confirming roadmap phase gates cover replay, projection equivalence, redaction,
   observability gaps, detector quality, interception latency, and override behavior;
6. reviewing the final diff for unrelated changes;
7. independently reviewing cross-document consistency before completion.

## Success Criteria

The refresh is successful when a new reader can determine:

- what PatchMesh is and is not;
- who the initial user is;
- what exists today;
- what the first working slice will do;
- which contracts must be settled before implementation;
- how each phase proves readiness for the next;
- which capabilities are deliberately deferred.
