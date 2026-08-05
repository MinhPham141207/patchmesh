# PatchMesh Phase 0 Foundation Design

**Date:** 2026-08-06

**Status:** Approved for implementation planning

## Context

PatchMesh is documentation-first and has no released implementation. The roadmap
marks Phase 0 as current and requires the first implementation slice to become
unambiguous and measurable before Phase 1 introduces a TypeScript/pnpm workspace,
runtime observation, SQLite storage, graph projections, or CLI commands.

The existing documents establish the product boundary and much of the vocabulary,
but they do not yet define executable contracts. Material gaps remain in identity
derivation and equality, resource-version representation, event compatibility and
ordering, unknown attribution, decision delivery, task-validity state, coverage
aggregation, replay equivalence, degraded behavior, security fixtures, and benchmark
methodology.

Phase 0 resolves those gaps as a language-neutral contract corpus backed by golden
fixtures and a dependency-free validator. It does not create product runtime code.

## Goals

1. Define canonical repository, worktree, workspace, integration-target, logical
   resource, version-domain, and resource-version identities.
2. Define an exact v1 event envelope and payload-discrimination rules.
3. Define idempotency, correlation, causation, attribution correction, source
   ordering, and unsupported-version behavior.
4. Keep coordination actions distinct from gateway directives and record their
   roadmap availability.
5. Separate task execution state from work-product validity and define guarded
   validity transitions.
6. Define decision-delivery state without pulling Phase 4 retry, expiry, override,
   or enforcement behavior forward.
7. Define dependency provenance, observability coverage, degraded-mode propagation,
   and replay/projection equivalence.
8. Add a threat model for local identity, event integrity, path handling, and
   redaction.
9. Add golden relevant, irrelevant, degraded, unattributed, duplicate, out-of-order,
   and integrity-failure scenarios.
10. Define benchmark protocols for interception latency, replay, and detector quality
    without inventing performance or quality thresholds.
11. Make every Phase 0 exit gate mechanically reviewable with a dependency-free
    repository validator.

## Non-Goals

- Creating the Phase 1 TypeScript/pnpm workspace or `packages/protocol`.
- Implementing an adapter, MCP proxy, gateway, daemon, SQLite store, projection
  engine, detector, policy engine, API, or CLI.
- Running real replay, projection, interception, or detector benchmarks.
- Selecting measured performance or detector-quality thresholds.
- Delivering decisions to a real runtime.
- Adding `delay`, `reject`, automatic pause, claims, leases, semantic enforcement,
  multiple adapters, remote services, or a dashboard.
- Finalizing later, unscheduled CLI concepts.

## Approaches Considered

### 1. Documentation only

This is the smallest change, but prose alone cannot prove schema completeness,
cross-file reference integrity, scenario coverage, redaction, or deterministic
failure behavior. It leaves the Phase 0 exit gates subjective.

### 2. Bootstrap the Phase 1 protocol workspace

A TypeScript package with a full JSON Schema implementation would provide strong
validation. It would also pull the Phase 1 workspace and boundary-validation
deliverables forward, contrary to the roadmap's explicit phase ordering.

### 3. Language-neutral contracts plus a dependency-free validator — selected

Versioned JSON Schemas, NDJSON event logs, expected-state documents, normative
Markdown, and a focused Node validator make Phase 0 measurable without creating
product runtime packages. The validator implements only the declared Phase 0 schema
subset and domain invariants. Phase 1 can later consume the same artifacts from
`packages/protocol`.

## Scope and Artifact Layout

```text
docs/protocol/
  identities.md
  events.md
  coordination.md
  validity.md
  evidence-and-coverage.md
  replay-equivalence.md
docs/THREAT_MODEL.md

schemas/phase0/v1/
  identities.schema.json
  event-envelope.schema.json
  graph.schema.json
  finding.schema.json
  decision.schema.json
  task-validity.schema.json
  coverage.schema.json
  scenario-manifest.schema.json

fixtures/scenarios/v1/
  relevant-exported-contract/
  irrelevant-concurrent-change/
  opaque-shell-degraded/
  late-attribution/
  duplicate-and-out-of-order/
  conflicting-duplicate-id/
fixtures/invalid/v1/
  path-traversal/
  cross-domain-reference/
  invalid-transition/
  coverage-overclaim/
  unsupported-schema/
  missing-reference/
  synthetic-secret/

benchmarks/phase0/
  README.md
  workloads.json

tools/phase0/
  validate.mjs
```

Every positive scenario directory contains:

```text
manifest.json
events.ndjson
expected-graph.json
expected-findings.json
expected-decisions.json
expected-validity.json
expected-coverage.json
```

Every manifest names the roadmap phase whose target behavior it describes. Negative
fixtures identify the expected stable validation error in their manifest and contain
only the inputs needed to reach that error. A scenario may omit derived-state files
only when validation must stop before projection, as in a conflicting duplicate event
ID.

## Identity Model

### Repository identity

`repositoryId` is an opaque PatchMesh-generated UUID. A future initializer persists
it in PatchMesh-owned metadata beneath the path returned by
`git rev-parse --git-common-dir`, allowing linked worktrees to share one identity.
It is not derived from a remote URL, filesystem root, branch, or commit.

Independent clones receive different repository IDs. Associating clones is an
explicit future operation and is not inferred from remotes or object history.

### Worktree and workspace identity

`worktreeId` is an opaque ID for one Git worktree and is independent of the worktree's
filesystem location. A future implementation persists it in PatchMesh-owned metadata
under that worktree's Git administrative directory.

`workspaceId` identifies one filesystem and execution context. A workspace refers to
one repository and may refer to one worktree. Multiple execution contexts may use the
same worktree, so `workspaceId` and `worktreeId` are not aliases.

All three identity fields are required in records where their entity is applicable.
Absence is represented explicitly by a nullable field defined by that record's
schema, never by an empty string or synthetic "unknown" ID.

### Integration targets and snapshots

`integrationTargetId` identifies a target definition of kind `branch`, `revision`, or
`candidate_aggregate`. Each compatibility or validity evaluation records an immutable
target snapshot containing:

- repository ID;
- target kind and normalized target locator;
- resolved base commit;
- ordered candidate IDs for an aggregate;
- a SHA-256 digest of the canonical snapshot representation.

A moving branch produces a new snapshot when its resolved commit changes. Candidate
ordering is significant. Validity evidence names the snapshot, not merely a mutable
branch name.

### Logical resources and domain-scoped versions

`resourceId` identifies a logical file, symbol, API, schema, or test inside one
repository. Equivalent resources in linked worktrees share a logical resource ID.
The ID never contains an absolute workspace path.

A `versionDomain` names the repository, workspace, and worktree context in which a
version was observed. A resource version is a discriminated record containing:

- resource ID;
- version domain;
- version kind;
- version value;
- observation evidence.

V1 version kinds are `git_commit`, `git_blob`, `content_hash`, `symbol_signature`,
`schema_version`, `api_version`, and `deleted`. Dirty or uncommitted files use a
content hash. Deletion uses the explicit `deleted` kind. A rename creates a new
logical resource identity and a separate rename relationship; identity continuity is
not guessed from content similarity.

The terms observed, candidate, target, integrated, and current describe a version's
role in an explicit comparison. They are not separate global version namespaces.
`Read Version` becomes an alias for `Observed Version` and is not used in schemas.

### Path normalization

Logical paths are UTF-8, Unicode NFC, repository-relative, slash-separated, and
case-preserving. Tracked paths use Git's recorded spelling. Absolute paths, NUL bytes,
empty segments, `.` segments, and `..` traversal are rejected. If a case-folding
filesystem maps two observed paths to one location, the collision is an identity
error rather than an implicit merge.

Symlinks retain the logical symlink path and record target evidence separately.
Normalization never silently dereferences a path outside the repository.

## Event Protocol V1

### Envelope

Every stored event has these fields:

```text
schemaVersion
eventId
eventType
source
timestamp
repositoryId
workspaceId
worktreeId
agentId: string | null
taskId: string | null
correlationId
causationId: string | null
sourceSequence: integer | null
payload
```

`schemaVersion` is the integer `1`. Phase 0 accepts exactly version 1. Unknown versions
are rejected with `PHASE0_SCHEMA_UNSUPPORTED`; they are never interpreted using the
nearest known schema.

`eventType` selects exactly one payload definition. Envelope and payload objects are
closed: undeclared fields fail validation. Each schema has a stable `$id`, and all
references remain repository-relative.

`timestamp` is an RFC 3339 UTC instant. It is observational metadata and never proves
causality or total order.

`source` contains a source kind, stable producer ID, and process-instance ID.
`sourceSequence`, when present, is a non-negative integer ordered only within that
process instance. A sequence gap records degraded coverage; it does not invent an
event or causality.

### Correlation and causation

`correlationId` groups one originating operation and all directly derived facts,
findings, and decisions. A root event has `causationId: null`. A derived event names
the single event that directly triggered it. Fan-in evidence belongs in explicit
`evidenceEventIds`; `causationId` is not overloaded into an array.

A missing causal parent may be buffered during incremental processing. At the end of
a bounded replay it is a reference error. Wall-clock order is never used to repair a
missing causal relationship.

### Idempotency and integrity

Event identity is idempotent by `eventId`. Content equality uses SHA-256 over an RFC
8785 canonical JSON representation of the complete event.

- A repeated event ID with the same canonical digest is a no-op.
- A repeated event ID with a different digest fails with
  `PHASE0_ID_CONFLICT`.
- Stored events are never overwritten or merged.
- Producer retries must reuse the original event ID.

### Attribution

`agentId` and `taskId` are required envelope fields whose values may be null. Null
means the source could not attribute the event at observation time.

Later attribution is represented by an `attribution.corrected` event containing the
target event ID, corrected agent and task values, reason, and evidence IDs. Projection
state may change; the original event bytes do not.

## Coordination and Decision Delivery

Every decision contains:

- stable decision ID;
- source finding ID;
- target agent or task;
- coordination action;
- gateway directive;
- reason and expected response;
- evidence IDs;
- confidence value and band;
- policy ID and policy version;
- coverage evidence and gaps.

Coordination action and gateway directive are separately typed. Their roadmap
capability matrix is:

| Phase | Coordination actions that may be produced | Gateway directives |
| --- | --- | --- |
| 0 | None; specification fixtures only | None |
| 1 | `record` only | `allow` |
| 2 | `record`, `notify`, `request_recheck`, `mark_possibly_stale`, `request_revalidation` | `allow`, `allow_with_notice` |
| 3 | Same action set as Phase 2; Phase 3 validation events may change validity projections | `allow`, `allow_with_notice` |
| 4 | Only actions explicitly enabled by a future Phase 4 design | `allow`, `allow_with_notice`, opt-in `delay`, opt-in `reject` |

Canonical actions that are not scheduled by the roadmap remain vocabulary only and
cannot be emitted until a roadmap update schedules them.

Decision state and delivery state are separate. Phase 0 defines stable delivery IDs
and the states `pending`, `delivered`, `acknowledged`, and `failed`. Duplicate delivery
or acknowledgment events are idempotent. Replay rebuilds delivery state but never
sends a message or executes a gateway directive.

Retry schedules, expiry, override, and crash-time redispatch are Phase 4 behavior and
are not defined here. A failed delivery remains recorded without an automatic retry
policy.

## Task Execution and Work-Product Validity

Task execution state and work-product validity are independent projections.
`completed` means execution ended; it is not a validity state.

V1 validity states are:

```text
unassessed
valid
possibly_stale
revalidating
stale
```

Allowed transitions are:

```text
unassessed -> valid
unassessed -> possibly_stale
valid -> possibly_stale
possibly_stale -> revalidating
revalidating -> valid
revalidating -> stale
revalidating -> possibly_stale
```

Guards are mandatory:

- `possibly_stale` requires evidence-backed dependency impact.
- `revalidating` requires a named work product and target snapshot.
- `valid` requires recorded successful validation against that target snapshot.
- `stale` requires failed validation or explicit deterministic proof.
- An inconclusive, interrupted, or superseded validation returns to
  `possibly_stale`; it cannot produce `valid` or `stale`.
- A validation result for an obsolete target snapshot is retained as evidence but
  does not transition current validity.
- Reworked output creates a new work-product validity record rather than mutating a
  stale record into an unrelated artifact.
- Corrections are new events, never edits to stored history.

## Dependency Provenance and Observability Coverage

Every dependency edge records logical endpoints, applicable resource versions,
evidence IDs, and one or more provenance observations. Canonical provenance values
remain `declared`, `statically_observed`, `dynamically_observed`, and
`semantically_inferred`. Each observation names its producer and analyzer or rule
version when applicable.

Coverage is evidence scoped to an operation or relationship, not a repository-wide
boolean. Canonical modes remain `intercepted`, `verified`, `inferred`, and `unknown`.
`intercepted` request evidence and `verified` effect evidence are orthogonal and may
both apply.

Findings and decisions reference their coverage evidence and list relevant gaps. An
`unknown` gap affecting the analyzed operation derives a degraded presentation state.
`inferred` evidence cannot silently substitute for interception or verification, and
coverage from an unrelated operation cannot upgrade a finding.

Opaque shell commands are observational in the MVP. A request may be intercepted,
while effects are verified afterward through filesystem, Git, process, or test
evidence. Any effect class that remains opaque is an explicit gap.

## Replay and Projection Equivalence

Phase 0 defines replay as consuming a stored event log to rebuild derived state with
all external side effects disabled. It does not mean rerunning tools, redelivering
decisions, or recomputing a different event history.

Canonical projection snapshots include graph nodes and edges, findings, decisions,
delivery state, work-product validity, and coverage. Snapshot arrays are sorted by
stable ID, object keys use canonical JSON order, and transient processing metadata is
excluded.

For a scenario, these executions must produce byte-equivalent canonical snapshots:

1. incremental processing in the manifest's canonical order;
2. cold replay of the complete stored log;
3. replay with identical duplicates inserted;
4. replay of a manifest-declared valid out-of-order permutation.

Conflicting duplicates, unresolved references at end of replay, or impossible state
transitions are deterministic errors and do not yield a partial success snapshot.

Future detector recomputation from observation-only events is a separate Phase 2
test mode. Phase 0 does not conflate it with projection replay.

## Threat Model

`docs/THREAT_MODEL.md` defines assets, actors, trust boundaries, threats, required
mitigations, residual risks, and fixture coverage for four required areas.

### Local identity

- Do not derive stable IDs from mutable or credential-bearing remote URLs.
- Treat adapter, gateway, watcher, and filesystem identity claims as untrusted input.
- Reject cross-repository, cross-worktree, and case-folding identity collisions.
- Record identity evidence and explicit associations.

### Event integrity

- Validate before storage or projection.
- Detect conflicting duplicate IDs by canonical digest.
- Reject unsupported schema versions and broken references.
- Preserve append-only history and distinguish observation failure from tool failure.
- Do not treat timestamps as authority.

### Path handling

- Reject absolute paths, traversal, NUL bytes, invalid normalization, and repository
  escape.
- Preserve symlink identity and record target evidence without unsafe dereference.
- Use temporary repositories and worktrees for future executable scenarios.

### Redaction

- Never store secrets, credentials, authorization headers, private environment
  values, or hidden model reasoning.
- Scan fixture keys and values for prohibited secret shapes.
- Use synthetic sentinel values in negative tests and `<redacted>` in valid fixtures.
- Validator errors report stable IDs, repository-relative paths, and JSON pointers;
  they do not echo rejected secret values.

Opaque or bypassed activity is a coverage limitation, not proof of safety. Phase 0
documents residual risks rather than claiming enforcement.

## Golden Scenario Corpus

### Relevant exported-contract invalidation

Agent B observes and depends on an exported function in one worktree. Agent A
produces a candidate signature change in another. Against a pinned integration target
snapshot, expected state contains the dependency path, deterministic finding,
`request_revalidation` action, `allow_with_notice` directive, and Agent B's work
product becoming `possibly_stale`.

### Irrelevant concurrent change

Agent A changes a resource outside Agent B's observed dependency path. Expected state
contains no invalidation finding, no disruptive decision, and unchanged validity.

### Opaque shell degraded mode

The shell request is intercepted but its prospective effects are opaque. Post-tool
filesystem or Git evidence verifies the actual change. Coverage records the
interception, verification, and remaining gap; expected output never claims complete
pre-write observation.

### Late attribution

An event arrives with nullable agent and task attribution. A later immutable
correction supplies attribution evidence. Incremental processing and replay converge,
and the original event remains unchanged.

### Duplicate and out-of-order convergence

Identical duplicate events and a causally valid out-of-order delivery permutation
produce the same canonical expected state as the canonical sequence.

### Conflicting duplicate ID

Two events share an event ID but have different canonical content. Validation stops
with `PHASE0_ID_CONFLICT`; no partial expected projection is accepted.

The corpus also contains negative fixtures for path traversal, cross-domain identity
references, invalid transitions, coverage overclaiming, unsupported schemas, missing
references, and synthetic secret patterns.

## Dependency-Free Validator

`tools/phase0/validate.mjs` runs with the Node runtime and imports only built-in
modules. It is a development tool, not a PatchMesh product CLI.

The validator:

1. discovers every Phase 0 schema, scenario, and benchmark definition;
2. validates JSON and NDJSON syntax;
3. validates a documented JSON Schema subset used by the Phase 0 schemas;
4. rejects unsupported schema keywords so validation strength cannot silently fall;
5. resolves local `$ref` values and rejects missing, cyclic, or escaping references;
6. checks required scenario files and manifest declarations;
7. checks ID uniqueness, reference integrity, repository/worktree/domain consistency,
   correlation, causation, source sequence, and duplicate-content rules;
8. checks action/directive capabilities and guarded validity transitions;
9. checks coverage propagation and expected degraded behavior;
10. canonicalizes and compares declared equivalent scenario variants;
11. scans valid artifacts and validator diagnostics for prohibited secret patterns;
12. validates benchmark metadata and measurement definitions.

The supported schema keywords are `$schema`, `$id`, `$ref`, `$defs`, `type`,
`properties`, `required`, `additionalProperties`, `items`, `minItems`, `uniqueItems`,
`enum`, `const`, `oneOf`, `format`, `pattern`, and `minimum`. Any other keyword fails
with `PHASE0_SCHEMA_KEYWORD_UNSUPPORTED`.

Diagnostics are sorted by repository-relative path, JSON pointer, and error code.
They never echo a rejected value. Stable primary error codes are:

```text
PHASE0_SCHEMA_INVALID
PHASE0_SCHEMA_UNSUPPORTED
PHASE0_SCHEMA_KEYWORD_UNSUPPORTED
PHASE0_REFERENCE_MISSING
PHASE0_ID_CONFLICT
PHASE0_TRANSITION_INVALID
PHASE0_COVERAGE_OVERCLAIMED
PHASE0_SECRET_PATTERN
```

Exit codes are `0` for a valid corpus, `1` for contract violations, and `2` for a
validator or invocation failure.

## Benchmark Definitions

Phase 0 defines measurement protocols and workloads but records no invented result or
acceptance threshold.

### Interception latency

Define paired baseline and instrumented operations, warm-up count, measured sample
count, environment metadata, error handling, and p50/p95 overhead calculation. The
workload distinguishes no-op/tool-routing overhead from file and shell observation.

### Replay

Define canonical event corpora and scale factors, cold-start rules, duplicate and
out-of-order variants, elapsed-time and events-per-second measures, peak memory, and
canonical snapshot verification.

### Detector quality

Define labeled relevant and irrelevant cases, finding identity rules, true-positive,
false-positive, false-negative, and true-negative classification, and per-detector
precision and recall. Baseline measurement and accepted thresholds belong to Phase 2.

Every result record must name the benchmark definition version, workload, environment,
warm-up, sample count, failures, and raw observations required to reproduce p50 and
p95 values.

## Documentation Synchronization

Implementation of this design updates the canonical documents together:

- `docs/TERMINOLOGY.md` owns canonical terms and distinctions.
- `docs/ARCHITECTURE.md` owns component responsibilities and data contracts.
- `docs/LIFECYCLE.md` owns state and transition semantics.
- `docs/ROADMAP.md` owns phase placement and exit gates.
- `docs/AGENTS.md` owns implementation guardrails.
- `docs/CLI.md` keeps examples illustrative and synchronized with protocol terms.
- `README.md` continues to describe PatchMesh as planned until runtime behavior exists.

Normative protocol details live in `docs/protocol/` and versioned schemas. Canonical
documents link to them rather than maintaining conflicting duplicate field lists.

## Verification

The Phase 0 implementation plan must verify at least:

```powershell
node tools/phase0/validate.mjs
git diff --check
rg -n "TBD|TODO|implement later|fill in details" docs/protocol docs/THREAT_MODEL.md schemas/phase0 fixtures/scenarios benchmarks/phase0 tools/phase0
```

The placeholder scan succeeds only when `rg` returns no matches. Additional plan
steps exercise every negative fixture and assert its expected stable error code.

## Success Criteria

Phase 0 is complete only when:

- every roadmap deliverable has a normative artifact;
- every scenario declares expected events, graph state, findings, decisions, validity,
  and coverage, except a declared pre-projection integrity failure;
- all event and state schemas have explicit identity and nullability rules;
- fixtures demonstrate correlation, causation, idempotency, late attribution, valid
  out-of-order convergence, and conflicting duplicate rejection;
- task execution and work-product validity are separate and every validity transition
  has an explicit guard;
- action/directive capabilities are roadmap-aligned and Phase 0–3 fixtures cannot use
  `delay` or `reject`;
- replay and projection-equivalence tests can be implemented without choosing new
  semantics;
- opaque shell and adapter limitations produce explicit coverage gaps;
- the threat model maps every required threat to a mitigation and fixture;
- benchmark definitions are reproducible and contain no fabricated results or
  thresholds;
- the dependency-free validator accepts the positive corpus and rejects every
  negative fixture with its declared code;
- canonical documents use consistent planned/target language; and
- no Phase 1 runtime, storage, adapter, package, or CLI implementation is introduced.
