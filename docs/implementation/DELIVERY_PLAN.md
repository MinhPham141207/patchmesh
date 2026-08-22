# PatchMesh Delivery Plan: Incremental Slices

> **Status:** Adopted. S1 and S2 are implemented — recall, in-flight visibility, and recap
> all ship. S3 is implemented but **unproven**: `overlaps` is correct and returns zero,
> because this repository's development has never run two agents at once. S4 is blocked on
> evidence a host hook cannot produce. S5 and S6 remain planned. This plan replaces the
> *sequencing* of Phase 2 and later work. It does not delete Phase 0/1 evidence or the
> Phase 2 milestone definitions; those remain valid descriptions of *what* to build. This
> document changes *what order* things get built in, and *what evidence is allowed to
> block* them.

## 1. Why Phase 2 stalled

Phase 2 has been "in progress" with M0 deferred and M1-M7 partial or blocked for a long
time. The cause is not implementation difficulty. It is a circular dependency baked into
the gate structure, and it is verifiable from the repository as it stands today:

**PatchMesh had no runnable recorder.** (Resolved by S1 and S2; this section records the
diagnosis that motivated the plan, and describes the repository as it stood before them.)

- No package depended on `@modelcontextprotocol/sdk`. No stdio transport, no server, no
  listening process existed anywhere in `apps/` or `packages/`.
- `packages/gateway/` and `packages/sdk/` were empty directories.
- `McpProxy` (`packages/adapters/src/mcp-proxy.ts`) is a *library* that some other
  program must call. `PatchMeshSiteMcpGateway` wraps that library for a host that does
  not exist.
- The only executable was `apps/cli`, which read a SQLite database that nothing wrote
  outside of tests and fixtures.

Every remaining blocker descends from that single fact:

```text
no runnable recorder
  -> no real agent traffic ever reaches the event store
    -> M7 cannot collect reviewed holdouts (30 positive + 150 negative per detector)
    -> M0 cannot produce a clean-revision controlled benchmark of real interception
      -> M0 sits at the TOP of the Phase 2 dependency graph and gates M1 and M2
      -> M7 sits at the BOTTOM and gates phase exit
        -> Phase 2 is walled at both ends by artifacts that require the runtime
           that was never built
```

The same failure appears a second time, one layer down, in the tool vocabulary. Until
this plan's S1 work, `ToolName` was a closed five-member enum — `read_file`, `edit_file`,
`run_shell`, `run_test`, `git_commit` — enforced by Ajv at append time. No real agent host
uses that vocabulary. A Claude Code session spends most of its calls on `Glob`, `Grep`,
`Task`, `TodoWrite`, and `WebFetch`, none of which could be expressed, so the store would
have rejected a real session even if something had been able to submit one. The protocol
was specified against an idealized runtime rather than an observed one.

Three secondary effects follow, and each one is visible in the current milestone doc:

1. **Detectors were built before their inputs existed.** M3, M4, and M5 are implemented
   and tested against synthetic fixtures, then marked "Partial" pending a labeled corpus
   that only real traffic can produce. They cannot advance by writing more code.
2. **The gates are calibrated for enforcement but applied to report-only output.**
   Precision >= 0.95, recall >= 0.90, Brier <= 0.10, and 180 independently reviewed
   cases per detector is a research-grade bar. It is the correct bar for a system that
   blocks or pauses an agent. It is the wrong bar for a line of text in a CLI report
   that no user has ever read, and it is an impossible bar for a product with no users.
3. **The unblocking artifact was outsourced.** M7 waits on "a real `patchmesh-site`
   runtime" owning an execution. That is an external dependency with no owner, no date,
   and no fallback. Work that cannot be unblocked from inside this repository, by one
   person, on one machine, is not a gate. It is a wish.

## 2. What this plan changes

Five principles, each aimed at one of the failures above.

**P1 - Ship a runtime before shipping judgment.** The recorder is the floor of the
product, not a downstream integration detail. Nothing is gated on judging agent behavior
until agent behavior is being recorded.

**P2 - Gate on authority, not on existence.** A detector may ship as soon as it is
explainable, dismissible, and off the critical path. It needs a quality corpus only when
it starts to *cost the user something* - context in an agent's window, a status change,
a blocked action. Evidence requirements scale with authority. See §5.

**P3 - Every slice is independently usable.** A slice that cannot be demoed to a user
who does not already know what PatchMesh is does not count as done. No slice may depend
on an artifact that only a later slice can produce.

**P4 - Gates must be self-producible.** An exit gate must be satisfiable inside this
repository, by one developer, on their own machine. External or third-party evidence may
*raise* confidence, but may never hold a blocking position. Anything external gets an
owner and a trigger, and the work routes around it in the meantime.

**P5 - Dogfood is the corpus.** PatchMesh records PatchMesh's own development. This repo
is already worked by coding agents; pointing them at PatchMesh's own recorder produces
real reads, real writes, real concurrent worktrees, and real overlap within days. The
`M6` feedback command - already code-complete - turns the developer's own dismissals into
labels. This breaks the circularity without waiting for `patchmesh-site` or any other
external host.

## 3. The product, restated

PatchMesh is a **shared work ledger for coding agents and their subagents.**

Agents write to it implicitly, by working through it. Agents read from it deliberately,
to find out what has already been done and what is being done right now, so that they do
not repeat it or collide with it. Everything else - detection, findings, coordination,
enforcement - is a refinement of the read side.

That framing sets the value order. Recording is worth something on its own. Recall is
worth more. Judgment is worth most, but only after the first two are real.

### The net-token invariant

Because the read side exists to reduce cost, it is bound by one rule that applies from
S2 onward:

> Any context PatchMesh returns to an agent must be smaller than the context that agent
> would otherwise have spent discovering the same thing.

Every recall response is budgeted and ranked. A recall tool that returns an unbounded
event dump fails this invariant and is a regression, not a feature. This is measurable
in-repo (tokens returned vs. tokens of the files the agent would have read) and it is an
exit criterion, not an aspiration.

## 4. The slice ladder

Six slices. Each names what a *user* can do at the end of it, what gets built, and an
exit bar that can be met on a laptop.

---

### S1 - Record (the floor) — **implemented**

**A user can:** run their agent normally and then run
`patchmesh events --database .patchmesh/ledger.db` to see every tool call that agent and
its subagents made — what was requested, against which file, what the outcome was, in
order, across sessions.

**Ingest is host hooks, not an MCP server.** This corrects the original draft of this
plan. An MCP server can only observe tools routed *to* it, and a coding agent's built-in
`Read`, `Edit`, `Write`, and `Bash` calls — where essentially all repository work happens
— never reach one. Recording only MCP traffic would have captured almost nothing.
Claude Code's `PostToolUse` hook fires on every tool call including built-ins and
subagent calls, so that is the ingest path. `McpProxy` remains for hosts without hooks.

**Built:**

- `packages/recorder`: maps a host hook payload onto the existing protocol events and
  appends them to a per-repository SQLite ledger at `.patchmesh/ledger.db`.
- An open tool vocabulary: `ToolName` gains `other`, and `tool.requested` gains an
  optional `hostToolName` carrying the host's own name. Both changes are additive — the
  Phase 0 corpus still validates — and together they let a real session be recorded at
  all. Unrecognized tools normalize to `other` and stay opaque rather than being guessed
  into a read or a write.
- Deterministic repository, workspace, and worktree identity derived from the filesystem
  with no subprocess. Linked worktrees of one repository share a `repositoryId`, which is
  what makes cross-worktree comparison possible later.
- A two-stage path, forced by measurement (see below): the hook appends the raw payload
  to an append-only journal, and `patchmesh-ingest` converts the journal into validated
  events once per session on `Stop`. Hook-time timestamps are preserved through ingest,
  so ordering reflects when work happened rather than when it was ingested.
- Fail-open throughout: both binaries always exit 0. A recorder that can break the
  user's agent gets uninstalled after one incident.

**Exit bar — met:**

- A real Claude Code session against this repository produces durable, replayable events.
  Verified live: this repository's own ledger was populated by an unattended session.
- Unrecognized and unattributable calls degrade coverage instead of being guessed. Task
  attribution is null, which is explicit and correctable by the existing
  `attribution.corrected` event.
- **Overhead measured on an ordinary developer machine, which is what replaces M0's
  clean-revision controlled artifact as the blocking gate.** The first implementation
  measured p50 633ms / p95 740ms per tool call and was **rejected**: roughly 320ms of it
  was Ajv import plus schema compilation, unavoidable in a per-call process. Splitting
  validation out of the hot path gives **p50 108ms, p95 166ms**, against a 65ms floor for
  bare Node startup. Accepted. A regression test walks the hook's transitive import graph
  and fails if anything heavier than a Node builtin reappears on it.
- Kill-the-recorder test: malformed input, absent worktree, and unparseable payloads all
  exit 0 and record nothing.

**Not in this slice:** detectors, findings, coverage judgments, directives. Also not in
it: in-flight visibility. Recording happens on `PostToolUse`, so the ledger shows
completed work only. Pre-tool visibility is S2's, because that is where it is first
needed.

**Carried defects to fix here** - recording durability is now the product floor, so
these stop being background cleanup:

- `SqliteEventStore.appendAtomic` calls `ROLLBACK` unguarded in its catch, which
  replaces the originating error when SQLite has already auto-rolled-back. Violates the
  spec invariant that persistence failure preserves the original error as `cause`.
- Both analyzers sort with locale-sensitive `localeCompare`, and that output feeds
  content digests on derived events. Fix it now, while the only affected digests are
  synthetic - after S1 there is real recorded history to migrate.
- The three PR5 audit gaps: gateway concurrency discovery can throw on unmatched
  historical lifecycle evidence; rejected dependent-write proofs can return sufficient
  coverage with no diagnostic; daemon detection does not validate the durable event set
  before deriving, so invalid replay looks like empty success.

---

### S2 - Recall (the payoff) — **implemented**

**A user can:** have their agents stop re-discovering things. Before a subagent explores
a file or starts a task, it asks PatchMesh what is already known about it and gets a
short, budgeted answer instead of re-reading the tree.

**Build:** the ledger exposed *back to agents* as MCP tools on the same server.

`packages/gateway` is that server, and ships all three tools.

- `patchmesh_recent_activity(path?, withinMinutes?, limit?, excludeAgentId?)` -
  **implemented** - who touched a file, when, under which task, with what outcome. Leads
  with observed file changes rather than tool calls: a call is what an agent asked for, a
  change is what the filesystem shows, and the second is the one a caller can act on.
- **In-flight visibility** - **implemented**, folded into `recent_activity` rather than
  given its own tool. Read live from the journal, not from the ledger: ingest runs on
  `Stop`, so anything the ledger holds has already finished. The originally planned
  `PreToolUse` protocol event proved unnecessary — the journal entry *is* the started call.
- `patchmesh_recap(agent?)` - **implemented** - a compact summary of prior tasks: who
  worked, for how long, which files changed, and which commits landed during the task.

**Exit bar:**

- Two agents working the same repository concurrently: the second one's in-flight view
  surfaces the first one's active work before it duplicates it. **Unproven, not blocked** —
  the mechanism works and reports running calls correctly; no session has ever run two
  agents at once for it to catch. This is the same gap S3 has, and it is a workload gap
  rather than a code gap.
- **Net-token invariant measured**: `.patchmesh/answers.ndjson` records what every answer
  cost. The displacement side — whether the caller went and read the file anyway — is
  **not yet measured**, so the invariant is instrumented on one side only. Closing it means
  joining those lines against the calls that follow them.
- Every response is bounded and ranked. No unbounded dumps. **Met:** an unnarrowed answer
  summarizes calls into a histogram rather than quoting shell command strings, which took
  one measured answer from 6,824 bytes to 1,343.

**Not in this slice:** any claim about whether work *conflicts*. S2 reports facts and
lets the agent decide.

It is the highest-value rung on the ladder and it needs no detector at all. The
implemented half needed nothing newly recorded either - only the attribution that makes
"who touched this" mean a specific agent rather than a whole session.

---

### S3 - Overlap, as an observation — **implemented, unproven**

**A user can:** run `patchmesh overlaps` and see where concurrent work touches the same
file, across worktrees.

**Build:** M3's detector, run over real S1 traffic - but demoted from "detector with
precision thresholds" to "an observation the user asked to see." Nothing is pushed.
Nothing changes state. Precision matters less when the user typed the command and can see
the evidence.

Built from **observed file changes** rather than the same-symbol projection: a hook-recorded
ledger never populates the latter, because shell commands are opaque. One implementation in
`packages/query`, shared by the CLI and the MCP tool.

**Exit bar:** findings are reproducible from stored events; each carries a stable
dependency path and source event IDs; a rebuild produces the same set; degraded coverage
is stated rather than guessed around. **No corpus gate** - the user is the reviewer, and
their dismissals via the existing feedback command become the first labels.

**Where it actually stands.** The rule is right and the false positives are gone: an
overlap requires two *distinct workers* — `(agentId, worktreeId)` — and a file the
repository calls work product. That took this repository's live output from 8 findings, all
of them another tool's SQLite cache and all of them one agent's own consecutive turns, to
**0 findings with 34 files still reported as observed**, so "nothing contested" stays
distinguishable from "nothing seen".

But zero is also all it has ever returned, because this repository has been developed by
one agent at a time in one worktree. Under this plan's own P3 — a slice that cannot be
demoed to a user who does not already know what PatchMesh is does not count as done — S3 is
**not done**, and no amount of further code will finish it. It needs a concurrent workload:
two worktrees, two agents, one shared file. That is a workload gap, not a code gap, and
naming it as such is the point of P4.

---

### S4 - The rest of the detectors, advisory

**A user can:** run `patchmesh stale` and `patchmesh contracts` for the same treatment.

**Build:** M4 and M5 over real traffic. M2's remaining analyzer-history gap gets designed
and closed here - this is the first slice that actually needs it, because re-auditing an
older derived fact only matters once there is real history to re-audit.

**Exit bar:** same as S3, per detector. Accumulated dismissal feedback from S3-S4 is now
a growing labeled corpus, produced as a side effect of use rather than as a prerequisite
to it.

---

### S5 - Notice in-band

**A user can:** have their agent told, inline, that what it is about to do overlaps
someone else's work.

This is the first slice where PatchMesh spends the agent's context without being asked,
so it is the first slice that must earn precision. `allow_with_notice` directives only.

**Exit bar - the quality gate applies here, and here is where it belongs:**

- Per-detector precision, recall, calibration, and false-positive measurement against the
  corpus accumulated in S3-S4 from real dogfood use.
- Thresholds fixed before the final run, per detector, with advisory-only exceptions
  named, owned, and expiring.
- Net-token invariant re-measured: an unsolicited notice that costs more context than the
  collision would have cost is a net loss.
- Irrelevant concurrent changes produce no notice.

External evidence - `patchmesh-site` or any other third-party host - **raises** confidence
here. It does not gate. If it arrives, it is added to the corpus.

---

### S6 - Authority

**A user can:** let PatchMesh mark work possibly-stale, request revalidation, and
eventually delay or reject.

This is where the original M7-grade bar, the enforcement scope currently listed under
"Explicitly Deferred," and the controlled-environment benchmark all correctly live. They
were never wrong requirements. They were attached to the wrong rung.

---

## 5. The authority ladder

The single structural change, stated on its own:

| Authority level | What PatchMesh does | Evidence required |
| --- | --- | --- |
| Record | Writes durable events | Replay determinism, overhead measured, fail-open |
| Recall on request | Answers when an agent asks | Bounded, ranked, net-token positive |
| Report on request | Answers when a *user* asks | Reproducible from events, coverage stated |
| Notice unrequested | Spends agent context uninvited | Per-detector quality thresholds on a real corpus |
| Change state | Marks stale, requests revalidation | Above, plus calibration and an appeal path |
| Enforce | Delays, rejects, redirects | Above, plus controlled-environment overhead, plus an owner |

Evidence scales with authority. A detector is never blocked from *existing* by evidence
it can only gather by existing.

## 6. Milestone mapping

Nothing is discarded. Things move.

| Existing | Disposition |
| --- | --- |
| Phase 0, Phase 1 | Unchanged, complete. S1 is their first real consumer. |
| M0 budget | **Unblocked by substitution.** S1 measures overhead on real sessions on a normal machine. The controlled clean-revision artifact moves to S6, where enforcement makes it worth the cost. |
| M1 contracts | Complete. Carried as-is. |
| M2 evidence | Language coverage complete. Analyzer-history gap moves to S4, with its own design, where it is first needed. |
| M3 overlap | Code carried to S3. Corpus gate removed at S3, reinstated at S5. |
| M4 stale read | Code carried to S4. Same treatment. |
| M5 contract invalidation | Code carried to S4. Same treatment. |
| M6 policy/CLI/feedback | Complete, and promoted: its feedback command is the label-collection mechanism for the whole ladder. |
| M7 detector quality | **Split.** The measurement machinery is kept and moves to S5. The external `patchmesh-site` dependency loses its blocking position under P4 and becomes optional corroboration. |
| `patchmesh-site` gateway | Kept as one adapter among several. No longer the sole path to real traffic; S1's own server is. |
| Enforcement (deferred list) | Unchanged scope, now explicitly landed at S6. |

## 7. Decisions taken at S1

1. **Host: Claude Code, via hooks.** Chosen because it already works this repository, and
   because its hooks see built-in tool calls that no MCP server can. See S1.
2. **Ledger scope: per-repository**, at `.patchmesh/ledger.db`, matching the existing
   per-repository identity rules. A per-machine ledger would have needed a cross-repo
   identity decision that nothing yet requires.
3. **Recall trust: advisory, never authoritative.** Recorded facts are presented to an
   agent as observations, not instructions. Retrofitting that distinction after agents
   depend on the answers would be expensive, so it is fixed before S2 writes its first
   recall tool.

## 8. Open questions for S2

1. **Subagent attribution.** Hook payloads carry a session identifier, and subagent calls
   currently record under the same agent as their parent with a null task. Distinguishing
   a subagent from its parent — and linking it to the `Task` call that spawned it — needs
   a host-shaped answer before `inflight` can honestly say *who* is working.
2. **In-flight representation.** A `PreToolUse` entry is a started, unfinished call.
   Whether that becomes a real protocol event or stays a journal-only runtime view is a
   protocol decision, and the closed event set means it cannot be added casually.
3. **Journal retention.** Ingest currently deletes the journal after draining it and
   parks unrepresentable entries in a `.rejected` file. Nothing prunes those yet.
