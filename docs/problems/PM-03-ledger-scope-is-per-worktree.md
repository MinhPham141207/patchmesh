# PM-03 — Ledger identity is per-worktree

- **Status:** `resolved` 2026-08-23
- **Severity:** high

## Resolution (2026-08-23)

**Most of this was already fixed when the problem was written, and the description below was
wrong about the central claim.** `ledgerRootFor` (`packages/recorder/src/identity.ts`) already
reduced a linked worktree to the repository's *primary* worktree, and `ledgerPathFor`
(`packages/recorder/src/record.ts`) already built the ledger path on top of it. Linked
worktrees have shared one `ledger.db` since that change. `overlaps` was already cross-worktree
capable, because `packages/query/src/overlap.ts` keys a worker on agent plus worktree and never
reads `workspaceId`.

What was genuinely still broken was narrower, and is now fixed:

- **`workspaceId` hashed the worktree, not the shared root.** Two worktrees wrote into one
  database carrying workspace ids that could never be compared, so the detectors that pair two
  events on workspace equality — `exported-contract-invalidation.ts:52` and
  `stale-read-before-write.ts:44` — were blind across worktrees even though the rows sat side
  by side. `resolveRepositoryIdentity` now derives the workspace from `ledgerRootFor`. A
  single-worktree checkout is byte-identical to before, so nothing migrates.
- **Multi-writer contention was untested.** Now covered: two linked worktrees drain
  concurrently into the shared ledger, both event sets land, the set validator passes, and the
  events carry two worktree ids under one workspace id.

Deliberately unchanged: the journal, snapshot and turn state stay per-worktree. The snapshot is
a diff baseline of one checkout's files, and sharing it across worktrees with different file
sets would read as a phantom change on every drain.

---

## The problem (as originally written; the first paragraph is now inaccurate)

`resolveRepositoryIdentity` derives the workspace from the worktree path
(`packages/recorder/src/identity.ts:193`):

```ts
workspaceId: `ws_${deterministicUuid("patchmesh:workspace", canonicalWorktree)}`
```

Linked worktrees therefore share a `repositoryId` but receive different `workspaceId`s, and
the ledger itself lives at the worktree root. Two worktrees keep two separate ledgers with
no shared store, so no query can see across them.

Git worktrees are the standard way to run several coding agents on one repository in
parallel. The configuration the product exists to serve is the configuration it cannot see.

## Evidence

```
worktree                                   events
wt_b169f6f5-b19d-5ad0-a8ab-0f48448673d5     3,666
wt_a920187e-f295-5ef0-923b-895639ae56eb         8
```

The second is the residue of the path-spelling defect closed in `ee99104`, not a real second
worktree. Cross-worktree coordination has never been exercised, and cannot be while each
worktree writes its own file.

## Why it matters

Every coordination claim silently assumes one worktree. Two agents in two worktrees editing
one file produce two ledgers, each showing a single uncontested writer, and `overlaps`
reports nothing while the collision happens.

## Candidate solutions

### A. Scope the ledger to the common Git directory — recommended

Resolve the ledger to the repository's common `.git` dir rather than the worktree root, so
every linked worktree appends to one store. Keep `worktreeId` on each event so per-worktree
views stay available.

- Likely the highest value per line of change in the repository: it is a path resolution and
  an identity derivation, and it unlocks the entire coordination premise.
- Requires a migration story for existing per-worktree ledgers, or an explicit decision to
  abandon them (they are per-machine state and gitignored, so abandoning is defensible).
- Introduces genuine multi-writer contention on one SQLite file. The append path already
  takes a write lock; this needs a concurrency test rather than an assumption.

### B. Federated read across discovered worktrees

Leave writes where they are; have queries run `git worktree list` and read every ledger.

- No migration, no write contention.
- Every query pays discovery and N database opens, and the CLI's fixed startup cost is
  already a known complaint. Overlap detection across stores has to merge and re-sort.

### C. Per-machine ledger keyed by repository

One store for everything, partitioned by `repositoryId`.

- Simplest coordination story, worst privacy and retention story — work from unrelated
  repositories lands in one file.
- `prune` exists, which softens retention but not the boundary question.

## Recommendation

A. B is a reasonable interim if the write-contention work looks large, but it makes the read
path permanently more complex to avoid a one-time migration.
