# PM-14 — `SessionStart` fires in bursts and re-serves identical context

- **Status:** `partial` 2026-08-24 — the duplicate injection is suppressed; the matcher is
  deliberately left alone until the newly recorded `trigger` field says which source fires it.
- **Severity:** medium

## The problem

The hook matcher `init` writes is `.*`, which for `SessionStart` matches every source the host
declares: `startup`, `resume`, `clear` and `compact`.

Measured on `.patchmesh/answers.ndjson` on 2026-08-24:

```
session_start_recap fires:            82
distinct payload sizes among them:    16
inter-fire gaps under 60s:            45 of 81
shortest gap:                         0.46s
```

Bursts of the *same bytes*, delivered to a session that already had them. Each fire costs
~0.64s of session-start latency and ~1.5 KB of context.

## Why it matters

Beyond the waste: **every fire incremented the answer count that PM-01 is judged by.** The
"88 answers returned" figure that stood as evidence the consumption gate was open was 77
injections, mostly of text already delivered. A metric that a bug can inflate is not evidence.

## Candidate solutions

### A. Narrow the matcher to `startup`

One line, and it kills roughly 80% of the fires.

**Deliberately not done.** Two reasons. First, it is a blunt instrument aimed at a target
nobody has actually seen: nothing recorded *which* source produced the bursts, so narrowing
would be guessing. Second, `resume` and `compact` are the moments an agent has just lost its
context and most needs it back — suppressing them wholesale would remove the hook's value at
exactly its most valuable moment. See the deferral note below.

### B. Content-dedupe within a session

Hash the injected text per session and skip an identical injection that lands again shortly
after. Catches the burst whatever source produced it, and does not care about the matcher.

### C. Delta injection — inject only what changed since this session's last injection

The best end state: a `resume` or `compact` re-injection stops being redundant and becomes
useful, because it carries only what is new. Larger, and it needs a diff of two recaps.

## Resolution (2026-08-24) — option B, with C still open

`packages/gateway/src/injection-state.ts` records, per session, the digest of what was last
injected and when. `main` consults it immediately before recording an answer:

- **Identical digest, same session, inside 5 minutes → nothing is emitted.** The burst dies.
- **Identical digest, same session, later than that → injected.** A compact an hour on is
  re-orientation, not noise, and gets the context back.
- **Different digest, different session, or a host that declares no session → always injected.**
- An unreadable or foreign-versioned state file fails **open**: a duplicate costs context, a
  suppressed first injection costs the entire point of the hook.

The file is bounded to 32 sessions, written best-effort, and lives beside the ledger at
`.patchmesh/session-start.json`.

**Also shipped:** the hook now records `trigger` — which of `startup`, `resume`, `clear` or
`compact` fired it — into the measurement row (PM-15). This is the diagnosis option A was
missing.

## Deferred, deliberately

- **The matcher stays `.*`.** A day of `trigger` values will say whether the bursts are one
  source firing repeatedly or four sources firing once, and that decides whether narrowing is
  a fix or a mistake. The harm it was aimed at is already gone.
- **Option C.** Worth building once there is reason to believe re-injections are frequent
  enough to be worth making different rather than merely quiet.
