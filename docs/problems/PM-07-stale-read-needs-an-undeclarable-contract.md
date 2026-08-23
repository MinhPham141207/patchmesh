# PM-07 — Stale-read detection needs a contract hooks cannot make

- **Status:** `structural` — option D (documentation) done 2026-08-23
- **Severity:** medium

## Option D done (2026-08-23) — the detector is marked unreachable at the source

`packages/core/src/stale-read-before-write.ts` now states, above the evidence interfaces, that
this detector cannot report findings from hook-recorded traffic and why: the declaration it
requires belongs to the proxied `McpProxy` authority model, and reads leave no trace to
recover. It stops reading as pending work.

The detector is kept, not deleted — it is correct and tested on the proxied path it was
written for.

Option A (the time-based reframe) is unstarted and belongs to the PM-02 `PreToolUse` advisory
rather than to this command.

---

## The problem

`patchmesh stale` cannot report findings from hook-recorded traffic, and no amount of
implementation work changes that. Two independent blockers, one of them permanent.

**1. Reads leave no trace.** Measured on the live ledger: 4 `read_file` calls carried a path,
against 182 shell commands that read (`cat`, `head`, `sed -n`, `grep`) and carried none.
The write-side equivalent of this problem was solved by observing the filesystem — but a
write leaves a difference on disk and a read leaves nothing at all. Recovering the path
would mean parsing intent out of shell commands, which the M7 constraint bans as
requested-path inference.

**2. The detector wants a declaration the host never makes.**
`detectStaleReadBeforeWrite` (`packages/core/src/stale-read-before-write.ts`) requires
`DependentWriteEvidence` carrying `dependsOnReadEventId` and a `readTokenDigest` — a write
that *explicitly declares which read it depends on*. That contract was designed for the
proxied `McpProxy` path with an authority model. Claude Code's hooks declare no such
dependency, and deriving one is inference again.

## Why it matters

This is not an unimplemented feature. It is a feature whose evidence contract a hook
recorder is structurally unable to satisfy, and it should stop being counted as remaining
work.

## Candidate solutions

### A. Reframe as time-based staleness — recommended

Drop the read-dependency contract. Answer a weaker but genuinely useful question: "this file
changed after you last touched it." Approximate the read with observed activity — the call
windows and changed files already recorded.

- Buildable today. It is also exactly the advisory PM-02 wants on `PreToolUse`.
- Weaker claim. It cannot say the write *depended* on the stale read, only that a change
  landed in between. For a warning, that is enough.

### B. Build the contract half of S4 instead

`detectExportedContractInvalidation` needs contract changes and an import graph. Both are
derivable by observation because analyzers can parse changed files off disk (see PM-05).

- Reachable, and it makes `contracts` a working command.
- Does not make `stale` work. It is a different detector.

### C. Recover reads via the transcript

The hook payload carries `transcript_path`. Reads are visible there.

- Turns an unanswerable question into a parsing problem.
- The transcript is the rawest, most secret-dense artifact in the system, and reading it
  reopens every privacy question `redact.ts` closed. Weigh heavily before starting.

### D. Mark `stale` structurally unreachable and say so in the docs

- Free, and it stops the question being re-asked every audit.

## Recommendation

A, folded into the PM-02 advisory rather than shipped as its own command. Do D at the same
time so the original detector stops reading as pending work.
