# Atomic Validated Persistence Design

Status: Proposed implementation specification

Repository baseline: `27f4bb51bf0050398c9289d49546472d3cd96f6c`

Scope: `@patchmesh/storage` transaction boundary, `@patchmesh/adapters` proof and
derived-evidence persistence, `apps/daemon` detection entrypoints

Authority: Report-only. This work MUST NOT add `delay`, `reject`, claims, or leases.

## 1. Purpose

Every PatchMesh guarantee rests on one claim: the durable event log is append-only,
replayable, and never contains a half-written derivation. That claim is currently
enforced per event, not per derivation. `SqliteEventStore.append` opens and commits
its own `BEGIN IMMEDIATE` transaction for a single event, so every caller that must
persist a *set* of causally bound events does so as a sequence of independent
commits.

This specification defines a single storage-level atomic validated batch boundary and
migrates the three callers that currently derive multiple bound events onto it.

It also corrects a diagnostic defect: the daemon currently relabels persistence
failures as replay-validation failures, which sends an operator to the wrong system.

This is a correctness and auditability change. It adds no detector, no finding kind,
no coordination action, and no gateway directive.

## 2. Current state

Verified against the baseline revision with the working tree applied. The workspace
builds, typechecks, and passes 286 tests; the Phase 0 corpus validates. The defects
below are latent, not test failures.

### 2.1 Storage exposes no set-level transaction

`packages/storage/src/event-store.ts` exposes exactly one write path, `append(input)`.
Its `BEGIN IMMEDIATE` covers one lookup and one insert. There is no batch API, and
`packages/storage/src/index.ts` exports none.

`packages/storage/src/database.ts` `openDatabase` sets `PRAGMA foreign_keys = ON` and
applies migrations. It sets neither `busy_timeout` nor `journal_mode`. Under
`BEGIN IMMEDIATE`, a second connection to the same database file therefore fails
immediately with a busy error rather than waiting out ordinary contention.

### 2.2 Daemon detection commits partial derivations

`apps/daemon/src/index.ts` `runSameSymbolDetection` and `runPhase2Detection` both read
durable history, derive records, then persist each record as two independent appends:

```ts
return createPhase2RuntimeRecords(writableStore.read()).map((record) => ({
  finding: writableStore.append(record.finding),
  decision: writableStore.append(record.decision),
}));
```

Two failure modes follow. A failure appending a record's decision leaves that
record's finding durably committed with no decision. A failure on record `n` leaves
records `0..n-1` durably committed. Both outcomes are observable to replay and to the
CLI as a real detection result.

Note that both entrypoints call `read()`, not `replay()`. Neither performs replay
validation today; `read()` returns raw arrival order without checking causal
integrity. §4.4 changes this deliberately — see §4.5.

### 2.3 Daemon catch scope conflates replay and persistence

The same `try` block wraps both the replay and every append, and its handler discards
the original error:

```ts
} catch {
  throw new ReadServiceError("unavailable", "Phase 2 detection is unavailable because durable replay validation failed");
}
```

An append failure — ID conflict, busy database, disk error — is therefore reported as
a replay-validation failure, with no `cause`. The message is actively misleading and
the real error is unrecoverable by the caller.

### 2.4 Proof validation and insert are separate operations

`packages/adapters/src/mcp-proxy.ts` `appendProofValidated` performs three separate
operations:

```ts
const diagnostics = validateEventSet([...eventStore.read(), parsed.value]);
if (diagnostics.length > 0) throw new ProtocolValidationError(diagnostics);
return eventStore.append(parsed.value).event;
```

The read observes one durable snapshot; the insert acquires its lock afterwards.
Another writer committing between them can render the history invalid at the instant
of insert. The proof is written anyway and sufficient coverage is returned over
invalid durable history.

The regression added in the working tree injects invalid history *between the two
validation passes* and correctly asserts degradation. That covers the pre-append
window only. The validate-to-insert window remains uncovered because no test can
currently interleave a writer inside the append itself.

### 2.5 Derived evidence batches commit partially

`persistDerivedSymbols` and `persistResolvedDependencies` each loop over a derived set
appending a fact event and its proof event per iteration, inside one broad `catch`
that returns a diagnostic string. A mid-loop failure leaves every prior iteration —
and possibly the current iteration's fact event without its proof event — durably
committed, while the caller is told only that persistence failed.

## 3. Non-negotiable invariants

RFC 2119 meanings apply.

1. A derivation that produces more than one causally bound event MUST become durable
   entirely or not at all.
2. Set validation MUST observe the same durable snapshot that the insert commits
   against. A validated candidate set MUST NOT be inserted against history that was
   not validated.
3. A persistence failure MUST NOT be reported as a replay, validation, or coverage
   failure, and MUST preserve the originating error as `cause`.
4. Existing single-event `append` semantics — canonical digest, idempotent duplicate,
   `PHASE0_ID_CONFLICT` on conflicting content — MUST remain byte-identical.
5. The batch boundary MUST NOT relax protocol validation. A batch that would produce
   an invalid event set MUST be rejected whole.
6. Absence of the atomic capability MUST fail closed or degrade. It MUST NOT silently
   fall back to sequential appends for any causally bound derivation batch. This
   covers proof-bearing (V3) writes and the V2 derived symbol and dependency batches
   alike: both are multi-event derivations, so both are governed by invariant 1.
7. This work MUST NOT introduce enforcement. All gateway directives remain `allow` or
   `allow_with_notice`.

## 4. Design

### 4.1 `SqliteEventStore.appendAtomic`

Add one method to `packages/storage/src/event-store.ts` and export its types from
`packages/storage/src/index.ts`.

```ts
export interface AtomicAppendOptions {
  /** Validate the locked durable snapshot plus all new candidates as one set. */
  readonly requireValidEventSet?: boolean;
}

appendAtomic(
  inputs: readonly unknown[],
  options?: AtomicAppendOptions,
): readonly AppendResult[];
```

Ordered algorithm:

1. Parse and canonicalize every input **before** opening the transaction. Any
   `ProtocolValidationError` rejects the batch with nothing acquired.
2. Reject a batch containing two distinct canonical digests under one event ID
   (`PHASE0_ID_CONFLICT`). Two byte-identical entries collapse to one insert and
   report `duplicate` for the repeat.
3. `BEGIN IMMEDIATE`.
4. Look up every candidate ID against the locked snapshot. An existing row with a
   differing digest raises `PHASE0_ID_CONFLICT`. An existing row with a matching
   digest is classified `duplicate` and excluded from the insert set.
5. When `requireValidEventSet` is set, read the locked durable snapshot and run
   `validateEventSet([...snapshot, ...genuinelyNewCandidates])`. Non-empty
   diagnostics raise `ProtocolValidationError`.
6. Insert every genuinely new candidate.
7. `COMMIT`. Any failure in steps 3–6 issues `ROLLBACK` and rethrows.

`append(input)` becomes `appendAtomic([input], ...)[0]`, preserving invariant 4.

Because validation in step 5 runs inside the write lock, invariant 2 holds: the
snapshot that was validated is the snapshot the insert commits against.

### 4.2 Connection settings

`openDatabase` gains `PRAGMA busy_timeout = 5000` before migrations, so ordinary
contention between the daemon and a gateway waits rather than failing. The timeout
value is a named exported constant, not an inline literal.

`journal_mode` is deliberately left unchanged in this specification. Changing it
alters the on-disk format and belongs to its own decision.

### 4.3 Adapter capability detection

`EventAppender` in `packages/adapters/src/types.ts` gains an optional member:

```ts
readonly appendAtomic?: (
  inputs: readonly unknown[],
  options?: { readonly requireValidEventSet?: boolean },
) => readonly { readonly status: "inserted" | "duplicate"; readonly event: ProtocolEvent }[];
```

`appendProofValidated` is replaced by `appendProofAtomic(events, eventStore)`:

- when `appendAtomic` is present, call it once with `requireValidEventSet: true` and
  return its `AppendResult[]` so callers can distinguish inserted from duplicate;
- when it is absent, **do not** fall back. Return a typed unavailability result so the
  caller degrades. This is invariant 6.

V3 proof generation in `execute` treats unavailability the same way it treats a failed
prospective validation: `validatedProofEvent` stays `null`, a `write.dependent`
observation gap is pushed, and coverage presents as `degraded`. The completed side
effect is never retried.

This requires restructuring `execute`, because the baseline had no prospective
validation to reuse — it validated inside `appendProofValidated` at append time, after
coverage had already been derived. Three changes follow, all deliberate:

1. **Coverage moves after the proof attempt.** The `write.dependent` gap pushed by a
   failed or unavailable proof must reach `deriveCoverage`, otherwise a suppressed
   proof would still report `sufficient` coverage. The baseline computed coverage
   first, so the gap could not affect it.
2. **The proof-path predicate widens.** `useProofPath` tested
   `targetSnapshot !== undefined && presentedToken !== undefined`. It becomes
   `requiresProofPath`, testing `targetSnapshot !== undefined && dependentWrite !== undefined`.
   A dependent write that declares no read token under a target snapshot previously
   slipped past the proof requirement entirely; it is now required to satisfy it or
   degrade.
3. **The V2 fallback under a target snapshot is removed.** `createDependentWriteEvent`
   returns `null` rather than emitting a V2 event when a target snapshot is present but
   the V3 bindings are incomplete. Emitting a weaker V2 event in a proof-bearing context
   would record an unproven dependent write as though it were ordinary evidence.

Prerequisite evaluation also moves off derived coverage onto the raw inputs
(`observationCoverageSufficient`), since coverage is no longer available at that point.

`persistDerivedSymbols` and `persistResolvedDependencies` build their full event list
first, then persist it with one `appendProofAtomic` call. On rejection they return
their existing diagnostic string and nothing is committed.

Both derived paths route **every** event through `appendProofAtomic`, not only the
V3 proof events. The pre-existing split — `appendProofValidated` for
`schemaVersion === 3` and a bare `appendValidated` for V2 — cannot satisfy invariant
1, because a fact event and its evidence event are one derivation regardless of
schema version. Routing them together means V2 derived evidence now also requires the
atomic capability and passes full set validation. This is a deliberate tightening, not
an omission.

The event-building loop MUST stay inside the same `try` as the append. Moving it out
narrows the catch so an analyzer or event-factory throw escapes the method instead of
becoming the documented diagnostic string — the mirror of the daemon defect in §2.3.

### 4.4 Daemon detection

Both entrypoints split replay from persistence and persist each record atomically:

```ts
let records;
try {
  records = createPhase2RuntimeRecords(writableStore.replay().orderedEvents);
} catch (cause) {
  throw new ReadServiceError("unavailable", "Phase 2 detection is unavailable because durable replay validation failed", { cause });
}
try {
  return records.map((record) => {
    const [finding, decision] = writableStore.appendAtomic([record.finding, record.decision], { requireValidEventSet: true });
    return { finding: finding!, decision: decision! };
  });
} catch (cause) {
  throw new ReadServiceError("unavailable", "Phase 2 detection could not persist derived records", { cause });
}
```

`ReadServiceError` in `@patchmesh/query` gains an optional `ErrorOptions` third
parameter so `cause` survives, satisfying invariant 3.

Whether the *whole run* is atomic — all records or none — is left as a follow-on
decision. Per-record atomicity is the invariant this specification establishes; a
run-level boundary would hold the write lock across an unbounded derivation and needs
its own contention analysis.

### 4.5 Declared behavior change: detection now replays

Both entrypoints move from `read()` to `replay().orderedEvents`. This is a deliberate
behavior change, not a refactor, and it is called out here because §6 otherwise
excludes changes to detector semantics.

`read()` returns raw arrival order and validates nothing. `replay()` validates causal
integrity and throws on a missing causal parent, a causal cycle, or an impossible
transition. Consequences:

- `runPhase2Detection` already surfaced *some* of these as `unavailable`, because
  `createRuntimeRecords` throws when a finding references missing causal evidence.
  Replay now catches them uniformly and earlier, whether or not a finding references
  the dangling event.
- `runSameSymbolDetection` had **no** `try`/`catch` at all. It now performs replay
  validation it never performed, and raises `ReadServiceError("unavailable")` on
  semantically invalid history rather than returning records derived from it.

The net effect is that a store containing a dangling causal reference *anywhere* makes
both detectors unavailable, where previously same-symbol detection would return
findings whenever no finding happened to reference the dangling event. This is a
fail-closed tightening consistent with the durability goal of this specification:
detection output derived from unvalidated history is exactly the contamination §8
argues the M7 corpus must not absorb.

Source-sequence gaps remain degraded coverage, not errors, so ordinary observation
gaps do not make detection unavailable.

Detector *output* is unaffected for valid history. The record factories build their own
lookup maps and sort their results by `findingId`, so causal ordering of the input
changes neither which findings are produced nor their order.

## 5. Test evidence

Each item is a required regression, not an optional check.

### 5.1 `packages/storage`

1. A two-event batch commits both events and returns both results in input order.
2. A batch whose second event is unparseable commits nothing and rethrows
   `ProtocolValidationError`; the store reads empty.
3. A batch whose second event conflicts with a stored ID commits nothing and raises
   `PHASE0_ID_CONFLICT`; the first event is absent afterwards.
4. A batch replayed verbatim returns `duplicate` for every entry and inserts nothing.
5. A batch containing one already-stored event and one new event inserts exactly the
   new event and reports `duplicate` and `inserted` respectively.
6. With `requireValidEventSet`, a candidate whose causal reference is absent from the
   locked snapshot is rejected whole.
7. With `requireValidEventSet`, a candidate whose causal reference is supplied by an
   earlier candidate **in the same batch** is accepted. This proves the batch is
   validated as a set rather than event by event.
8. A second connection appending while a batch holds the write lock waits for
   `busy_timeout` and then succeeds, rather than failing immediately.
8a. A failure that rolls the transaction back *itself* still propagates its own error.
   A `BEFORE INSERT` trigger raising `RAISE(ROLLBACK)` unwinds the transaction, so the
   explicit `ROLLBACK` in the catch fails; that secondary failure MUST NOT replace the
   originating error, and nothing may be durable afterwards. Test 16 uses `RAISE(ABORT)`,
   which leaves the transaction open and therefore cannot detect this. The same class
   covers `SQLITE_FULL`, `SQLITE_IOERR`, and a failed `COMMIT`, all of which auto-roll
   back. Without this case invariant 3 is unverified for every self-rolling-back failure.

### 5.2 `packages/adapters`

9. A proof-bearing dependent write persists its `write.dependent` event through
   `appendAtomic` exactly once, and `validateEventSet(store.read())` is empty.
10. An `EventAppender` without `appendAtomic` degrades: no proof write is created,
    coverage presents `degraded`, a `write.dependent` gap is reported, and the
    executor runs exactly once.
11. An `appendAtomic` that throws `ProtocolValidationError` degrades identically and
    does not surface as `McpProxyStorageError`.
12. A derived-symbol batch that fails on its final proof event leaves zero derived
    symbol or evidence events durable, and the caller receives the existing
    `derived symbol event persistence failed` diagnostic.
13. Interleaving check for §2.4: a store whose `appendAtomic` commits an invalidating
    event immediately before validating must still reject the batch, because the
    invalidating event is inside the validated snapshot.
14. A store with **no** `appendAtomic` member persists no derived symbol or evidence
    events at all, reports `derived symbol event persistence failed` in
    `analysisDiagnostics`, emits a matching `source:<path>` observation gap, and
    presents `degraded` coverage. This exercises the `unavailable` return, which a
    throwing `appendAtomic` does not reach.
15. The dependency equivalent of the previous item MUST isolate the two derived paths
    rather than disabling both. A `get appendAtomic()` accessor that returns the real
    binding for its first four lookups and `undefined` afterwards lets symbol
    persistence commit while dependency persistence finds the capability gone, so the
    test can assert that symbol events are durable while `dependency.changed` and
    dependency-kind `evidence.derived` are absent.

### 5.3 `apps/daemon`

16. A store whose second append fails leaves neither the finding nor the decision
    durable, and `store.read()` contains no `finding.created` for that record. A
    `BEFORE INSERT` SQLite trigger raising `ABORT` on `decision.created` is the
    cheapest way to force a genuine mid-batch failure.
17. That same failure raises `ReadServiceError` with code `unavailable`, the message
    `could not persist derived records`, and a `cause` whose message identifies the
    originating SQLite failure.
18. The existing semantically-invalid-replay regression still raises the *replay*
    message, proving the two paths stay distinguishable.
19. The existing feedback and no-op detection tests remain unchanged and passing.

## 6. Out of scope

- `journal_mode` / WAL migration.
- Run-level atomicity across all derived records in one detection pass.
- Any Phase 4 claim, lease, or fencing-token mechanism. `appendAtomic` is a storage
  transaction boundary; it is not arbitration and MUST NOT be described as such.
- Any change to detector thresholds, corpus, or M0/M7 gate status. Detector semantics
  are unchanged **except** for the availability tightening declared in §4.5, which is
  in scope precisely because it is declared there.

## 7. Open follow-on decisions

Neither item below is implemented by this specification. Both are recorded here so
they are not rediscovered as defects.

### 7.1 Set-validation cost inside the write lock

`requireValidEventSet` reads and parses the entire `events` table — `JSON.parse` plus a
full `parseEvent` per stored row — then runs `validateEventSet` over the whole history,
while holding `BEGIN IMMEDIATE`. Two callers pay this, and both costs are new:

**The daemon.** It invokes this once per derived record, so a detection pass costs
`O(records × total events)` with the write lock held throughout. Before this change the
daemon performed no set validation at all.

**The adapter interception path.** `persistDerivedSymbols` and
`persistResolvedDependencies` now route every derived batch through `appendProofAtomic`
with `requireValidEventSet: true`, so a full-history parse and validation happens on
*every intercepted tool call that changes a source file*. This is the more sensitive of
the two: the daemon runs detection out of band, whereas this cost lands inside the
synchronous interception window that the M0 p95 budget in `tools/phase2` gates. Before
this change the V2 derived paths used a bare `appendValidated` with no set validation,
and only V3 evidence validated — against an unlocked snapshot, outside the transaction.

The tightening is required by invariant 1 and is not negotiable, but its placement on
the interception path means the M0 budget must be re-measured before this work can be
cited as M0-neutral. This specification does not claim that neutrality.

This is correct but does not scale, and it now interacts with the `busy_timeout` added
in §4.2: a long validation pass on a large store can push a concurrent gateway append
past its 5 s wait. The candidate remedies are validating only the causal closure
reachable from the batch rather than the full history, maintaining an incremental
validation digest, or moving to one run-level transaction. Choosing among them needs a
measurement on a realistically sized store, which belongs with the deferred M0
benchmark work rather than here.

### 7.2 Whether source-analysis coverage should gate the dependent-write proof

`deriveChangedSourceEvents` returns a diagnostic string for an unsupported extension,
which pushes a `source:<path>` observation gap. That gap enters
`preProofObservationGaps`, so `observationCoverageSufficient` becomes false and the
proof-bearing dependent write is suppressed. Editing a `.md` or `.json` file in the
same tool call as a TypeScript file therefore suppresses the M4 stale-read proof.

The *gap-to-suppression* coupling predates this specification. The surrounding gate does
not: §4.3 widened the proof-path predicate and removed the V2 fallback, so the set of
calls reaching this suppression is larger than it was. That makes the interaction more
reachable, not less, and strengthens the case for revisiting it.

It is recorded because the two evidence classes are independent: a dependent-write proof
binds an observed read token to a completion-linked effect, and it does not rest on
symbol analysis of an unrelated file in the same call. Narrowing the gate would need its
own design, because loosening a degraded-observability guard is exactly the kind of
change `docs/AGENTS.md` requires explicit justification for. No test currently covers the
proof path with an unsupported file present in the same call.

## 8. Effect on phase status

None. This work does not advance any Phase 2 milestone from `Partial` to complete and
does not unblock M7. It removes a durability defect beneath the existing detectors so
that the eventual M7 corpus cannot be contaminated by partially committed
derivations. `docs/implementation/phase2/PHASE_2_MILESTONES.md` requires no status
edit as a result of this change.
