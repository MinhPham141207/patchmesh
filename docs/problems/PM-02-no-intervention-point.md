# PM-02 — Detection is post-hoc; nothing intervenes

- **Status:** `open` — option A now delivers to the agent, but one hook later than intended:
  via `PostToolUse` `additionalContext`, not `PreToolUse` before the write. The `PreToolUse`
  channel stays built and wired for when the host gains a non-blocking way to reach the model
  there; today it reaches only the user's transcript.
- **Severity:** high
- **Depends on:** PM-01

## Before the write, at last (2026-08-24) — `UserPromptSubmit` turn-start advisory

`computeTurnStartAdvisory` (`packages/recorder/src/advisory.ts`) names the files other agents
already have in flight, delivered through `UserPromptSubmit` `additionalContext` — which reaches
the model, and fires before the turn's first tool call. **This is the first thing PatchMesh says
before a write rather than after one**, which is what this problem file asked for.

It needed no host configuration change. `UserPromptSubmit` was already wired to the recorder
binary by `patchmesh init` as the turn boundary that gives ordinary work a task, so — like the
`Pre`/`PostToolUse` stages — this is a decision inside an invocation that already happened.

What it gives up for being early: `UserPromptSubmit` carries no `tool_input`, so there is no path
to match and the notice is repository-wide rather than about the file being edited. It reports
only in-flight calls whose host tool names a path (`Edit`/`Write`); an opaque `Bash` call is left
out rather than reported as a path it may not touch. It is silent when nothing is in flight —
a notice on every turn saying there are no collisions is PM-12's permanently-degraded mistake in
a new costume — and it reports what it withheld once the list runs past five paths.

Measured: the `UserPromptSubmit` path costs about 15ms more than the existing `PostToolUse` path
end to end, consistent with the in-flight reader's measured import cost.

**The three stages now sit in a ladder**, all on hooks that were already installed: turn start
(before any write, repository-wide), `PreToolUse` (before one write, path-scoped, but its output
is not confirmed to reach the model), and `PostToolUse` (after one write, path-scoped, confirmed
to reach the model).

## Delivery landed (2026-08-24) — PostToolUse additionalContext is confirmed to reach the model

`PreToolUse`'s `allow` reason turned out to speak only to the user, so it satisfied "advisory,
never blocking" without satisfying "warns the agent" — a detector that was correct but talked
to nobody. `packages/recorder/src/advisory.ts` now also computes the identical contention
check on `PostToolUse` (`computePostWriteAdvisory`), one call after the write instead of
before it, and `packages/recorder/src/bin.ts` emits it as `hookSpecificOutput.additionalContext`
(`emitPostWriteAdvisory`) — verified directly against the live host docs (code.claude.com/docs/en/hooks,
fetched 2026-08-24, not assumed from training memory): `additionalContext` is documented as
valid for `PostToolUse` and is delivered into the current turn, reaching Claude's own context,
unlike `PreToolUse`'s `allow` reason.

The message is honest about the stage: `"<agent> has a call in flight (<tool>) that started
touching \`<path>\` <N>s ago and has not finished. You just wrote \`<path>\` too. Same file
does not mean same work."` It says the write already happened rather than pretending this is
still a warning before the fact — weaker than PM-02's original intent (the agent has already
compounded onto a possibly-contended file by the time it hears about it), but it is the first
time this information reaches the agent *while it is still true*, rather than only at
Stop-time ingest or through a voluntary MCP call that happens roughly once per 163 tool calls.

**No double warning of the agent.** Both `emitAdvisory` (`PreToolUse`) and
`emitPostWriteAdvisory` (`PostToolUse`) run unconditionally on every invocation of the shared
binary; each gates on its own `hook_event_name`, so at most one of them ever has something to
say for a given invocation (one hook firing is either a `PreToolUse` call or a `PostToolUse`
call, never both). Even on the calls where `PreToolUse`'s check also finds contention, its
output is not confirmed to reach the model at all, so `PostToolUse`'s `additionalContext`
remains the only advisory an agent actually reads. `PreToolUse`'s path is otherwise untouched —
this was additive, so when the host gains a non-blocking `PreToolUse` channel, that path is
already correct and ready.

Tests in `packages/recorder/test/advisory.test.ts` (18 total for this file) cover both stages:
firing on genuine contention, self-exclusion, Bash opacity, failure isolation from the journal
write for each stage independently, and end-to-end checks through the compiled binary that
exactly one hook-output line is ever produced per invocation (never both shapes at once).
`pnpm --filter patchmesh-recorder test`: 89/89 pass, import-graph guard included.

**Evaluated and deliberately not built this pass: `UserPromptSubmit`.** Its `additionalContext`
is also documented as valid, and is delivered *before* any tool call in the turn — closer to
PM-02's real intent (before the write) than `PostToolUse` is. It is worth building as a
turn-start contention notice, but two things stop it here: `UserPromptSubmit` is not currently
wired to the recorder binary at all (a genuinely new hook, not a decision inside one that
already fires, unlike `PreToolUse`/`PostToolUse`), and wiring it means editing
`.claude/settings.local.json`, which is out of this package's scope. It would also answer a
different question than the per-edit check here — contention as of turn start, not as of this
specific file — so it is a complement to this work, not a replacement.

## Option A built (2026-08-24) — detection lands, emission stops at a documented dead end

`packages/recorder/src/advisory.ts` adds `computeContentionAdvisory`, wired into
`packages/recorder/src/bin.ts`'s existing `PreToolUse` invocation (`emitAdvisory`, its own
try/catch, called after the journal append so a failure there can never cost the recording).
It fires only for `Edit`/`Write` on `tool_input.file_path`, calls `readInFlightCalls` with
`excludeAgentId` set to the caller's own derived agent id, and reports what it observed rather
than what it implies: `"<agent> has a call in flight (<tool>) that started touching
\`<path>\` <N>s ago and has not finished. Same file does not mean same work."` Bash and every
other opaque host tool are skipped outright, before any in-flight read happens — never
inferred safe or unsafe. Tests in `packages/recorder/test/advisory.test.ts` cover firing,
self-exclusion, Bash opacity (including a command that names the contested path verbatim),
failure isolation from the journal write, and end-to-end behavior through the compiled binary.
The import-graph guard (`test/journal.test.ts:165`) still passes — `advisory.ts` and
`inflight.ts` import only `node:` builtins and recorder-local siblings.

**Measured added cost**, this machine, current load: the marginal import (`inflight.js`, the
one new dependency) added roughly 5ms in a delta measurement against the pre-existing
`identity.js`+`journal.js`+`redact.js` baseline taken back-to-back on the same loaded system,
and separately about 11ms in an earlier quieter measurement
([[pm-02-s-advisory-is-hot-path-viable-today]]) — both comfortably inside the "well under
20ms" budget. `computeContentionAdvisory` itself costs a 0.2–0.4ms median per call on an empty
journal, the common case.

**What is unresolved.** The binary currently emits `hookSpecificOutput.permissionDecision:
"allow"` with the advisory as `permissionDecisionReason` — confirmed non-blocking, since
`"allow"` bypasses the permission system outright, so this never trips the "never block on a
false positive" rule. What is *not* confirmed is whether that reason reaches Claude's own
context on `PreToolUse` at all: the host's documentation states the `"allow"` reason is shown
to the user only, and that the only two `PreToolUse` channels documented to reach the model —
`deny` and `ask` — both block, which this problem file itself rules out until the advisory has
a measured false-positive rate. No `additionalContext` field is documented for `PreToolUse`
(unlike `SessionStart`/`PostToolUse`/`UserPromptSubmit`). So today this advisory is verifiably
non-blocking and cheap, and its detection is verifiably correct against the journal, but
whether it actually reaches the agent it is meant to warn is not established — that is the
next thing to verify, not something this change should have guessed at.

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
