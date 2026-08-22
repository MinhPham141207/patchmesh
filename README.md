# PatchMesh

PatchMesh is a **shared work ledger for coding agents and their subagents.** Agents write
to it implicitly, by working through a host hook. They read from it deliberately, to find
out what has already been done and what is being done right now, so they do not repeat it
or collide with it.

> **Project status:** the recorder and the read side work and are dogfooded — this
> repository's own ledger holds several days of real agent sessions. The surface that pays
> off first is **session continuity** (`patchmesh_recap`), which needs no concurrency at all.
> File-level overlap is validated on a staged two-session workload; detection beyond it is
> not demonstrated: see [What is not proven](#what-is-not-proven). The build order is in the
> [delivery plan](docs/implementation/DELIVERY_PLAN.md).

## The problem

A coding agent starts every session knowing nothing about the last one. It re-reads files
another agent already read, re-derives conclusions already reached, and — when two agents
work at once — edits files another agent is holding.

Git detects textual merge conflicts, worktrees isolate changes, orchestrators assign tasks.
None of them records *what the agents actually did*, which is the thing the next agent needs
and the thing that is thrown away when a session ends.

PatchMesh records it, and hands it back on request:

```text
A fresh agent asks: what happened in this repository recently?
PatchMesh answers: these 15 files changed, by this worker, under this task,
                   and these 2 calls are still running right now.
```

**Continuity is the payoff, and it arrives before coordination does.** The first question a
new session actually asks is "what did the last one do?", and `patchmesh_recap` answers it —
tasks, spans, files changed, commits landed — on a single agent working alone. Collision
detection matters, but it only pays when two agents genuinely run at once; continuity pays
on every session, including the one you are about to start.

That inverts the value order this project was planned around. Recording was assumed to be
worth least and judgment most; measured against real use, the ranking runs the other way,
and the roadmap follows the measurement rather than the plan.

### The net-token invariant

The read side exists to reduce cost, so it is bound by one rule:

> Any context PatchMesh returns to an agent must be smaller than the context that agent
> would otherwise have spent discovering the same thing.

Every answer is bounded and ranked, and every answer's size is recorded to
`.patchmesh/answers.ndjson` so the claim is measurable rather than asserted. An answer that
quotes shell command strings back at a caller fails this rule, which is why an unnarrowed
recall summarizes calls instead of listing them.

## Quick start

```bash
npm install -D patchmesh patchmesh-recorder patchmesh-gateway
npx patchmesh init
```

Or from a clone of this repository:

```bash
corepack pnpm install && corepack pnpm build
node apps/cli/dist/main.js init
```

`init` writes a command the rest of your team can use. Installed as a dependency it writes a
path relative to the repository root, so `.mcp.json` and the hook config are safe to commit;
installed globally it writes the bin names; run from a clone it writes that clone's absolute
path, which is correct for a developer and correct to keep out of a shared file.

`init` merges the recorder's host hooks into `.claude/settings.local.json`, registers the
`patchmesh` MCP server in `.mcp.json`, and adds `.patchmesh/` to `.gitignore`. It is additive
and idempotent: hooks belonging to other tools are never modified, and re-running reports what
is already configured rather than appending a second copy. Restart the agent session so it
loads the hooks.

Then work normally. The question to ask first, at the start of your next session, is what
the last one did — that is `patchmesh_recap`, and an agent can call it over MCP without you
typing anything. From the CLI:

```bash
npx patchmesh events   --database .patchmesh/ledger.db
npx patchmesh overlaps --database .patchmesh/ledger.db
npx patchmesh prune --older-than 30 --database .patchmesh/ledger.db
```

Agents get the same ledger back over MCP as `patchmesh_recap` (what previous sessions did),
`patchmesh_recent_activity` (what changed, optionally scoped to one path), and
`patchmesh_overlapping_work` (which files more than one task touched).

## What works today

Verified against this repository's own ledger, not against fixtures:

- **Session continuity.** `patchmesh_recap` summarizes previous sessions — tasks, spans,
  call counts, files changed, and the commits each task landed, matched by committer time.
  It needs no concurrency, so it returns real value on the ordinary one-agent-at-a-time
  workflow, and it is the surface to reach for first.
- **Recording.** A Claude Code `PostToolUse` hook journals every tool call — including
  built-in `Read`, `Edit`, `Write`, and `Bash`, which no MCP server can see — and
  `patchmesh-ingest` converts the journal into validated events on `Stop`. Measured
  overhead **p50 108ms, p95 166ms** per call against a 65ms bare-Node floor. Fail-open
  throughout: both binaries always exit 0.
- **Effect observation, bound to the call that caused it.** The worktree is captured per
  turn and diffed, so a file written by a shell command is recorded even though the command
  named no path. Each change is then matched to the call whose `[PreToolUse, PostToolUse]`
  window contains the file's mtime, and binds only when exactly one call's window does —
  ambiguity stays attributed to the turn rather than guessed at. This routes around shell
  opacity without ever interpreting a command, and it is what lets two sessions sharing one
  drain each keep their own attribution instead of both recording as unattributed.
- **Attribution.** Subagents get their own `agentId` and task, so an answer names the
  subagent that made an edit rather than the session that contained it.
- **Recall, over MCP.** `patchmesh_recent_activity`, `patchmesh_overlapping_work`, and
  `patchmesh_recap` — bounded, ranked, and caveated as observations rather than
  instructions.
- **Reports, over the CLI.** `status`, `agents`, `events`, `graph`, `overlaps`, `explain`,
  plus `feedback` and `delivery` as append-only responses.
- **Retention.** `patchmesh prune --older-than <days>` keeps replay intact.

## What is not proven

Stated plainly, because a green test suite is not evidence that a product works:

- **Concurrency is validated on a staged workload, not an organic one.** `overlaps` fires
  correctly when two sessions contend on one file, exercised end to end through the real
  recorder and real drains. But it still returns zero on this repository's own history,
  because development has been one agent at a time in one worktree. The detector is
  demonstrated; a real concurrent team has not used it.
- **One file's contention is only visible across drains.** Snapshot diffing sees final
  state, so a file written by two agents inside one drain window yields one change and one
  surviving mtime. This is a property of diff-based observation, not a bug.
- **Cross-worktree overlap has no shared store.** The ledger lives at the worktree root, so
  two worktrees keep two ledgers. Ledger scope — per-worktree, per-repository, or
  per-machine — is still an open decision.
- **`stale` and `contracts` cannot fire on hook-recorded data.** They are typed against
  `file.read` / `write.dependent` and `symbol.changed` / `dependency.changed`, which a host
  hook does not produce. Both decline and name the missing evidence rather than reporting
  "no findings" — an inability, not a silence.
- **Reads are invisible, and no amount of observing fixes it.** Roughly four in five
  recorded calls are shell commands. A write leaves a difference on disk that observation
  can find — which is how effect binding recovers it — but a read leaves no trace at all,
  and recovering one would mean parsing intent out of a command. Coverage reports this as a
  gap instead of guessing.
- **Displacement is unmeasured.** Answer *cost* is recorded; what an answer *saved* is not,
  so the net-token invariant is instrumented on one side only.

## Architecture

```text
Coding agent (host hooks)
    -> append-only journal          .patchmesh/journal.ndjson
    -> ingest (validate, attribute) .patchmesh/ledger.db
    -> SQLite event store
    -> work-graph projection + read services
    -> MCP tools (to agents) and CLI reports (to people)
```

PatchMesh is not a coding agent, task planner, general orchestrator, Git replacement,
test replacement, or project-management platform.

## Principles

- Observe intended operations and verify actual effects.
- Prefer deterministic evidence before semantic reasoning.
- Distinguish events, findings, decisions, and enforcement.
- Never claim stronger consistency than observation coverage supports.
- Choose the least disruptive safe response.
- Explain every decision with reproducible evidence.
- Treat completed work as potentially invalidatable until revalidated.

## Documentation

- [Delivery plan](docs/implementation/DELIVERY_PLAN.md) — the build order actually in use,
  and why evidence requirements scale with authority
- [CLI](docs/CLI.md) — every command, its output, and its exit behavior
- [Vision](docs/VISION.md) — problem, promise, boundaries, and long-term direction
- [Roadmap](docs/ROADMAP.md) — the original phase structure the delivery plan resequenced
- [Architecture](docs/ARCHITECTURE.md) — components and technical contracts
- [Lifecycle](docs/LIFECYCLE.md) — agent, task, event, decision, and revalidation flows
- [Terminology](docs/TERMINOLOGY.md) — canonical vocabulary
- [Agent rules](docs/AGENTS.md) — implementation constraints for repository changes
- [Phase 0 contracts](docs/protocol/identities.md) — versioned identities, events,
  coordination, validity, evidence, replay fixtures, security, and benchmark inputs

## Development

Node 24 or newer is required: the event store is built on `node:sqlite`'s `DatabaseSync`,
which makes the version a correctness constraint rather than a preference.

```bash
corepack pnpm check
```

One command — build, typecheck, the full test suite, the Phase 0 contract corpus, and
evidence trace validation. CI runs exactly this, so a green pipeline and a green laptop
mean the same thing.

## Contributing

Read `docs/implementation/DELIVERY_PLAN.md` and `docs/AGENTS.md` before proposing
implementation work. Do not describe planned behavior as implemented behavior — the
[What is not proven](#what-is-not-proven) section above is part of the contract, not a
disclaimer to be quietly trimmed.
