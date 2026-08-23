# PM-08 — Most recorded traffic is opaque

- **Status:** `partial` — option B shipped 2026-08-23
- **Severity:** medium

## Resolution (2026-08-23) — option B shipped, and it bought less than expected

`deriveProjectionCoverage` no longer counts an opaque call as a gap when its effects were
observed and bound to it. Opacity is a statement about *intent*; once the filesystem
observation binds a write to a call, the effect is known exactly as well as an `Edit` call's is.

One implementation detail mattered and was not obvious: **`tool.completed.effectEventIds` is
always empty on the hook path.** The completion is written when the call returns, and the
filesystem is not diffed until the turn drains, so the linkage runs the other way — from the
`file.changed` event back to the completion, via `causationId`. `effects.ts` sets that only
when exactly one call's window covered the change (`soleCallCovering`), so a non-null causation
*is* the deterministic binding. Coverage now indexes changes by the completion they name.

**The measured gain was much smaller than this file estimated.** The recommendation said "a
large share of the 1,414 are calls whose effects *are* known". Against the live ledger the
opaque gap count fell from **1,460 to 1,407** — 53 calls, not a large share. Coverage rose
from 7% to 10%.

That is the honest answer and it is worth keeping: the overwhelming majority of opaque calls
are shell *reads*, which leave nothing on disk to bind. The reporting was mislabelled, but it
was not much overstated. Option C — accept the boundary and document it — is looking like the
right end state for the remainder, and option A's prefix matching would move this number by
very little.

---

## The problem

`tool-mapping.ts` deliberately marks `Bash` and unknown tools opaque rather than guessing
what they did. `patchmesh status` reports the consequence:

```
Coverage gap: opaque (1,414) opaque operation effects are not prospectively enumerable
Coverage gap: unattributed (201) resource change has no intercepted causal parent
Coverage: degraded
```

Under bypass-permissions mode the harness explicitly instructs Bash-first for reads and
edits, so `Edit` and `Write` largely stop being used. This is not only a bypass-mode
artifact — git, build, test, grep and sed are shell in every mode.

## What is already mitigated

The write half is largely solved. Observed filesystem changes now bind to the call whose
window contained the write, using file mtime plus the `PreToolUse` start time, without
parsing a single shell command. A file mutated through a heredoc is no longer invisible.

What remains opaque is the *operation*: the ledger knows a call changed a file, not what the
call was trying to do. And the read half is unrecoverable (PM-07).

## Why it matters

Opacity is honest and correct. But it means hook traffic cannot satisfy detector inputs that
need to know intent, and `overlaps` rows still read `Coverage gap: opaque` rather than
findings.

## Candidate solutions

### A. Classify shell commands by effect, not by intent

`git commit` is already recognised when a command unambiguously begins one. The same
narrow, unambiguous-prefix approach extends to a handful more: `git checkout`, `git merge`,
`npm test`, `pnpm build`.

- Stays inside the existing rule — recognise, never guess. An unrecognised command remains
  opaque.
- Diminishing returns fast; the long tail of shell is genuinely arbitrary.

### B. Stop treating opacity as a coverage failure

An opaque call whose effects were observed and bound is not a gap — the effect is known even
though the intent is not. Coverage accounting currently counts it as missing anyway.

- Fixes PM-12 at the same time.
- Purely a reporting change; no new evidence.

### C. Accept it permanently and document the boundary

- Free. Correct. The honest end state for the long tail.

## Recommendation

B first — a large share of the 1,414 are calls whose effects *are* known, and counting them
as gaps understates real coverage. Then A for the handful of high-frequency prefixes.
