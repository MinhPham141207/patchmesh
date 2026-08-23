# PM-02 — Detection is post-hoc; nothing intervenes

- **Status:** `open`
- **Severity:** high
- **Depends on:** PM-01

## Precondition met (2026-08-23) — the signal the advisory would carry is now calibrated

Option A cannot be built on a signal nobody has measured, and this file's own exit bar (S5:
"the first slice where PatchMesh spends the agent's context without being asked, so it is the
first slice that must earn precision") says so. That precision now exists.

`findOverlappingWork` had no concurrency test at all: an overlap was any file two distinct
workers changed inside whatever window the caller passed, so the answer was a function of
`--within` rather than of the work. It returned 20 files on this ledger at any window from eight
hours out, of which **13 were sequential edits** by workers who had each finished before the
next began — precision about **0.35**.

It now requires that the earlier writer was still active after the later one wrote, carries the
evidence for that claim on the finding, and is scored by a labelled corpus of real recorded rows
in `tools/phase2/overlap-corpus.ts` with a gate that runs in `pnpm check`. Current: precision
1.0, recall 1.0, zero false positives, on 7 real contentions and a matched set of negatives.

See [docs/measurements/overlap-precision.md](../measurements/overlap-precision.md).

**What this does and does not unblock.** It is enough to justify building the advisory on this
signal. It is *not* the S5 exit bar, which wants a corpus accumulated from real use across
detectors — that still needs findings to be persisted (PM-11), and it still needs more than one
repository and one developer.

Option B (blocking `PreToolUse`) remains firmly out until the advisory has a measured
false-positive rate in the wild.

---

## The problem

Every surface PatchMesh has is a report about work that already finished. `overlaps` names
files two agents both changed — after both changes are on disk. `recap` describes tasks that
have ended. The ingest that produces the data runs on `Stop` and `SessionEnd`, so by
construction the ledger describes the past.

A tool that manages agents has to be able to say something *before* the write. Nothing in
the product does.

## Evidence

`patchmesh overlaps --within 10080` reports 20 contested files. Every row is a pair of
completed writes. Not one of them was reported while it could still have changed an outcome.

The delivery plan's S5 (unsolicited in-band notice) and S6 (authority and enforcement) are
both unbuilt.

## Why it matters

This is the difference between a flight recorder and an air traffic controller. The product
is named for the second and currently ships the first. It is also the gap between "PatchMesh
observed a collision" and "PatchMesh prevented one" — only the second is worth paying for.

## Candidate solutions

### A. Advisory warning on `PreToolUse` — recommended first step

`PreToolUse` is already wired and already recording. It is the only moment in the loop that
sits before a write. On an edit to path P, check whether P was changed by a different worker
recently and, if so, emit a warning as hook output.

- Everything needed is already recorded: `file.changed` with timestamps, agent, task.
- Must stay advisory and fail open. A hook that can block the agent gets uninstalled — the
  same principle that already governs the recorder's always-exit-0 design.
- The latency cost is real and already measured: p50 281ms per call against a 185ms node
  floor. A warning path must not add a second process spawn.

### B. Deny with reason (`PreToolUse` blocking)

The host supports refusing a tool call outright.

- Powerful and dangerous. A false positive stops real work, and PM-04 says attribution is
  weakest under exactly the concurrency that would trigger it.
- Do not build until the advisory version has a measured false-positive rate.

### C. Advisory claims — `patchmesh claim <path>`

An agent registers intent before working; `PreToolUse` warns when another agent's claim
covers the path.

- Turns observation into coordination, which is the product's actual promise.
- Requires agents to cooperate, which returns to PM-01: they will not call it unless
  something tells them to.

### D. Live tail for the human — `patchmesh watch`

Not intervention, but it puts a person in the loop who can intervene.

- Cheap. Useful for demos. Does not scale past one watcher.

## Recommendation

A, gated behind PM-01 being solved. Keep C in view as the design target; C is what "managing
agents" means, and A is the mechanism it would use.
