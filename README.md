# PatchMesh

PatchMesh is a **shared work ledger for coding agents and their subagents.** Agents write
to it implicitly, by working through a host hook. They read from it deliberately, to find
out what has already been done and what is being done right now, so they do not repeat it
or collide with it.

> **Project status:** the recorder and the read side work and are dogfooded — this
> repository's own ledger holds several days of real agent sessions. Detection beyond
> file-level overlap is not demonstrated: see [What is not proven](#what-is-not-proven).
> The build order is in the [delivery plan](docs/implementation/DELIVERY_PLAN.md).

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

The value order is deliberate. Recording is worth something on its own; recall is worth
more; judgment is worth most, and only after the first two are real.

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
pnpm install && pnpm build
node apps/cli/dist/main.js init
```

`init` merges the recorder's host hooks into `.claude/settings.local.json`, registers the
`patchmesh` MCP server in `.mcp.json`, and adds `.patchmesh/` to `.gitignore`. It is additive
and idempotent: hooks belonging to other tools are never modified, and re-running reports what
is already configured rather than appending a second copy. Restart the agent session so it
loads the hooks.

Then work normally. Afterwards:

```bash
node apps/cli/dist/main.js events   --database .patchmesh/ledger.db
node apps/cli/dist/main.js overlaps --database .patchmesh/ledger.db
```

Agents get the same ledger back over MCP as `patchmesh_recent_activity`,
`patchmesh_overlapping_work`, and `patchmesh_recap`.

## What works today

Verified against this repository's own ledger, not against fixtures:

- **Recording.** A Claude Code `PostToolUse` hook journals every tool call — including
  built-in `Read`, `Edit`, `Write`, and `Bash`, which no MCP server can see — and
  `patchmesh-ingest` converts the journal into validated events on `Stop`. Measured
  overhead **p50 108ms, p95 166ms** per call against a 65ms bare-Node floor. Fail-open
  throughout: both binaries always exit 0.
- **Effect observation.** The worktree is captured per turn and diffed, so a file written
  by a shell command is recorded even though the command named no path. This is what
  routes around shell opacity without guessing at a command's intent.
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

- **Concurrency has never been observed.** `overlaps` correctly returns zero on this
  repository, because its development has been one agent at a time in one worktree. The
  detector is honest; the workload has not exercised it.
- **`stale` and `contracts` cannot fire on hook-recorded data.** They are typed against
  `file.read` / `write.dependent` and `symbol.changed` / `dependency.changed`, which a host
  hook does not produce. Both decline and name the missing evidence rather than reporting
  "no findings" — an inability, not a silence.
- **Reads are largely invisible.** Roughly four in five recorded calls are shell commands,
  and a read leaves no trace on disk for the observer to find. Coverage reports this as a
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
