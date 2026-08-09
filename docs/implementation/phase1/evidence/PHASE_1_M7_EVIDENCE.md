# Phase 1 M7 Evidence: Golden Slice, Resilience, and Performance Gate

**Status:** Historical verification snapshot

**Verification date:** 2026-08-08

**Verification base revision:** `b01fa43a3e0d5e3d469bc51cab3b16ff3e4f10b8`
(`b01fa43`)

**Phase 1 completion revision:**
`644a9e6f983bb7601e35e8f7ab3c1c26474b8adf` (`644a9e6`, M7 gate)

The command results below apply to the recorded verification base. The completion
revision records the completed Phase 1 milestone and is not presented as a rerun of
that historical command set.

## Scope Implemented

M7 adds a repository-level `tools/phase1` harness. It verifies the observation-only
cross-worktree exported-contract stream, replay and projection equivalence, immutable
attribution correction, restart recovery, duplicate and out-of-order behavior,
redaction, failed/interrupted outcomes, and degraded coverage for opaque and
snapshot-origin-uncertain operations.

M7 remains report-only. The harness emits no Phase 2 findings, decisions, validity
records, `delay`, `reject`, overlap, stale, or revalidation output.

The replay benchmark measures the in-memory `replayEvents` core after deterministic
variant preparation. SQLite duplicate insertion and restart behavior are covered by
the M7 resilience tests. Projection rebuild equivalence is covered separately by the
golden suite, avoiding repeated full projection rebuilds in the replay timing loop.

## Exact Verification Commands

Focused M7 commands passed:

```text
corepack pnpm phase1:typecheck
corepack pnpm phase1:test
corepack pnpm --filter @patchmesh/storage test
corepack pnpm phase1:benchmark -- --output docs/implementation/phase1/evidence/PHASE_1_M7_BENCHMARKS.json
```

The M7 harness passed 15/15 tests. The storage package passed 32/32 tests, including
the 20,000-event replay performance regression. The full raw benchmark artifact is
[`PHASE_1_M7_BENCHMARKS.json`](PHASE_1_M7_BENCHMARKS.json).

Final repository verification also passed:

```text
corepack pnpm test                         107 workspace tests passed
corepack pnpm typecheck                    9 workspace projects passed
corepack pnpm build                        9 workspace projects passed
node tools/phase0/validate.mjs             Phase 0 corpus valid
node --test tools/phase0/*.test.mjs       47 tests passed
git diff --check                           passed; no whitespace errors
```

## Golden and Resilience Results

- The producer and consumer worktrees project agent, task, symbol, file, version,
  read, and change state without Phase 2 findings or decisions.
- Canonical, duplicate, and valid out-of-order variants converge to the same ordered
  event and graph snapshot digests.
- Incremental projection and clean replay snapshots are byte-equivalent.
- Duplicate event IDs are idempotent; conflicting content fails with
  `PHASE0_ID_CONFLICT`.
- Missing causal references fail with `PHASE0_REFERENCE_MISSING` without a partial
  replay result.
- Closing and reopening SQLite preserves event and projection digests.
- Nullable attribution is accepted and `attribution.corrected` changes projected
  attribution without mutating the target event bytes.
- Failed and interrupted MCP operations persist explicit non-successful
  `tool.completed` outcomes.
- Real `NodeObservationBoundary` captures a changed file and links its effect event
  from the originating tool completion.
- Opaque shell effects produce degraded coverage instead of transparent attribution.
- Diagnostic credential-shaped values are redacted before presentation.

## Performance Results

Environment metadata recorded in the raw artifact:

| Field | Value |
| --- | --- |
| OS | `win32 10.0.26200` |
| Architecture | `x64` |
| CPU | `13th Gen Intel(R) Core(TM) i5-13420H` |
| Memory | `16813264896` bytes |
| Node | `v24.15.0` |
| Definition | `phase0-v1` |

Interception overhead results are nanoseconds, with raw paired samples in the JSON
artifact:

| Workload | Warm-up | Samples | p50 | p95 | Failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| `benchmark_interception_noop_route` | 100 | 1,000 | 19,245,500 | 33,994,400 | 0 |
| `benchmark_interception_small_file_read` | 100 | 1,000 | 19,406,200 | 34,437,000 | 0 |
| `benchmark_interception_opaque_shell` | 50 | 500 | 23,819,500 | 83,032,700 | 0 |

Replay results are nanoseconds for elapsed replay time:

| Workload | Warm-up | Samples per variant | p50 | p95 | Failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| `benchmark_replay_1000` | 3 | 10 | 5,292,900 | 9,099,100 | 0 |
| `benchmark_replay_10000` | 3 | 10 | 74,656,800 | 128,936,000 | 0 |
| `benchmark_replay_100000` | 1 | 5 | 1,394,742,800 | 1,726,091,200 | 0 |

Every successful canonical, duplicate, and out-of-order replay variant produced the
same snapshot digest before timing comparison. Raw observations include every
measured sample, peak memory, throughput, digest, and failure field.

## Proposed Phase 2 Budget

**Proposed proxy-only baseline:** p95 gateway interception overhead of 50 ms for noop
routing and deterministic file reads, and 100 ms for opaque shell operations, measured
with the same Phase 0 workloads, sample counts, and environment metadata. This is a
proposal for review at the Phase 2 M0 gate, not a Phase 1 pass/fail threshold or a
budget for complete filesystem interception.

**Acceptance owner:** PatchMesh maintainers responsible for the Phase 2 M0 gate.

The interception benchmark uses a deterministic zero-file observation boundary to
isolate gateway routing, event validation, and persistence overhead. Real Git,
filesystem, content-hash, failed-process, interrupted-process, and opaque-operation
observation is verified in `observation.test.ts`; its full filesystem scan cost is a
known residual limitation of this baseline. Phase 2 M0 must add and accept a separate
full-`NodeObservationBoundary` benchmark, including a representative workspace scan,
before applying an end-to-end interception budget.

## Phase Boundary and Residual Limitations

- Phase 1 remains observation-only and report-only. No detector, finding, policy,
  coordination decision, or disruptive directive was added.
- The benchmark does not measure full `NodeObservationBoundary` scan cost per sample;
  that cost is covered functionally, not included in the proxy-only baseline, and must
  be measured and accepted at Phase 2 M0.
- The harness uses local temporary repositories and SQLite databases only. It does not
  provide network transport, cross-process subscriptions, or sandbox-level bypass
  prevention.
- The proposed budget remains unaccepted until the Phase 2 M0 gate reviews this
  environment and workload definition.
