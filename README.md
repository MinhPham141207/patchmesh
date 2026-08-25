# PatchMesh

**A shared work ledger for coding agents.** PatchMesh records what your agents actually did —
every tool call, every file they changed, which agent and which task — and hands it back when
the next session asks.

Agents write to it implicitly, through host hooks. They read from it deliberately, to find out
what has already been done, so they don't repeat it or collide with it.

```text
A fresh agent asks:  what happened in this repository recently?
PatchMesh answers:   these 15 files changed, by this worker, under this task,
                     and these 2 calls are still running right now.
```

**Report-only.** No command pauses, rejects, or redirects an agent. Both hook binaries always
exit 0, so a broken PatchMesh can never break your session.

---

## Requirements

- **Node.js 24 or newer.** Not a preference — the event store is built on `node:sqlite`'s
  `DatabaseSync`, which does not exist in earlier versions.
- **Git.** The repository is the unit of identity.
- A host that supports hooks. Claude Code is the supported host today.

Check with `node --version`.

---

## Install

### Globally (recommended for personal use)

```bash
npm install -g patchmesh
```

That is the whole install. The CLI carries the recorder and the MCP server as dependencies, and
`patchmesh init` resolves them from wherever npm put them — so the hooks work even though npm
links only the CLI's own binary onto your PATH.

### Per repository (recommended for teams)

```bash
npm install -D patchmesh
npx patchmesh init
```

Prefer this if `.mcp.json` is committed. A dependency install lets `init` write
**repository-relative** paths, which is the only form that resolves on a teammate's machine.

### From a clone

```bash
corepack pnpm install && corepack pnpm build
node apps/cli/dist/main.js init
```

---

## Set up

Run this once inside the repository you want recorded:

```bash
patchmesh init
```

It is additive and idempotent — hooks belonging to other tools are never touched, and re-running
reports what is already configured instead of appending a second copy.

| It writes | What for |
|---|---|
| `.claude/settings.local.json` | Five hooks: `UserPromptSubmit` (turn boundary → gives work a task), `PreToolUse` (in-flight visibility), `PostToolUse` (the record of work done), `Stop` and `SessionEnd` (drain the journal into the ledger) |
| `.mcp.json` | Registers the `patchmesh` MCP server so agents can read the ledger |
| `.gitignore` | Adds `.patchmesh/` — the ledger is local, per-checkout, and not shared |

**Then restart your agent session** so the host loads the new hooks. Nothing is recorded until
you do.

To check that it took:

```bash
patchmesh doctor
```

Both hook binaries always exit 0, so a broken PatchMesh is silent by design — and silence looks
exactly like an idle repository. `doctor` is what tells the two apart. It exits non-zero only
when recording is actually broken.

Useful flags: `--force` (overwrite existing entries), `--no-hooks`, `--no-gitignore`, `--json`.

### What gets recorded

Tool calls and observed file changes, written to `.patchmesh/ledger.db` inside your repository.
Nothing leaves your machine.

`git worktree` gives one repository several roots; they all record into the primary worktree's
ledger, so work done in a feature worktree is visible from the main one and the other way
around. The journal and the filesystem snapshot stay per-worktree, because a snapshot is a diff
baseline of one checkout's files.

Payloads pass through a **key whitelist** before the first disk write — only fields the recorder
actually reads are kept, with credential-pattern redaction as a backstop and text capped at 512
characters. File *contents* and full tool responses are never journalled.

To remove old history while keeping the ledger replayable:

```bash
patchmesh prune --older-than 30
```

---

## Use

Every report command defaults to `.patchmesh/ledger.db` in the current repository and works from
any subdirectory, so no flags are needed.

### Start here — what did the last session do?

```bash
patchmesh recap       # tasks, spans, calls, files changed, and the commits each task landed
```

This is the surface that pays off first: it returns real value on a single agent working alone
and needs no concurrency at all. Agents ask the same question for themselves through the
**`patchmesh_recap`** MCP tool, which returns the same answer — one implementation, so the two
cannot drift.

### The rest

```bash
patchmesh agents                  # workers and their tasks, subagents nested under parents
patchmesh status                  # store health, counts, observation coverage
patchmesh events --limit 50       # durable event page (--type, --since, --follow, --raw)
patchmesh graph                   # serve the work-graph explorer, print its link
patchmesh overlaps                # files more than one worker changed (--within <minutes>)
patchmesh explain <decision-id>   # full explanation for one decision
```

Add `--json` to any of them for machine-readable output.

### For agents, over MCP

| Tool | Answers |
|---|---|
| `patchmesh_recap` | What did previous sessions do? |
| `patchmesh_recent_activity` | What changed recently, optionally scoped to one path? |
| `patchmesh_overlapping_work` | Which files did more than one task touch? |

Every answer is bounded and ranked, and its size is logged to `.patchmesh/answers.ndjson`, so
this rule is measurable rather than asserted:

> Any context PatchMesh returns to an agent must be smaller than the context that agent would
> otherwise have spent discovering the same thing.

---

## How it works

```text
Coding agent (host hooks)
  -> append-only journal           .patchmesh/journal.ndjson   (per call, redacted)
  -> ingest on Stop                validate, attribute, drain
  -> SQLite event store            .patchmesh/ledger.db
  -> work-graph projection + read services
  -> MCP tools (to agents) and CLI reports (to people)
```

**Shell commands name no files, so PatchMesh watches the disk instead.** Roughly four in five
recorded calls are `Bash`, which carries no path argument. The worktree is captured per turn and
diffed, so a file written by a shell command is still recorded. Each change is then matched to
the call whose `[PreToolUse, PostToolUse]` window contains the file's mtime — and binds **only
when exactly one** call's window does. Ambiguity stays attributed to the turn rather than
guessed at. No shell command is ever parsed.

---

## What is not proven

Stated plainly, because a green test suite is not evidence that a product works:

- **Concurrency is validated, but not by a real team.** `overlaps` fires correctly when two
  sessions contend on one file, and has since fired on genuine two-agent contention in this
  repository. It has not been used by a team working concurrently by design.
- **One file's contention is only visible across drains.** Snapshot diffing sees final state, so
  a file written by two agents inside one drain window yields one change and one surviving
  mtime. A property of the approach, not a bug.
- **Two worktrees now share one ledger**, so cross-worktree overlap works — staged with the
  real binaries in two linked worktrees contending on one file, and `overlaps` reports it from
  either side. What is still unproven is the same thing as above: no team has run it. The
  ledger lives under the repository's *primary* worktree, so a single-worktree checkout is
  unaffected and nothing had to be migrated.
- **Reads are invisible, and observing harder will not fix it.** A write leaves a difference on
  disk; a read leaves no trace at all. Recovering it would mean parsing intent out of shell
  commands, which this project does not do.
- **`stale` and `contracts` cannot fire on hook-recorded data.** They are typed against evidence
  a host hook does not produce, so they decline and name what is missing rather than reporting
  "no findings" — an inability, not a silence.
- **Displacement is unmeasured.** Answer *cost* is recorded; what an answer *saved* is not.

---

## Documentation

- [Delivery plan](docs/implementation/DELIVERY_PLAN.md) — what is built, in what order, and why
- [Features](docs/features/) — proposed capabilities, designed and sequenced but not yet built
- [Problems](docs/problems/) — what is wrong now, with status, evidence and solution options
- [CLI reference](docs/CLI.md) — every command and flag
- [Architecture](docs/ARCHITECTURE.md) · [Terminology](docs/TERMINOLOGY.md) ·
  [Threat model](docs/THREAT_MODEL.md)
- [Protocol](docs/protocol/) — [events](docs/protocol/events.md),
  [identities](docs/protocol/identities.md), [evidence and coverage](docs/protocol/evidence-and-coverage.md),
  [replay equivalence](docs/protocol/replay-equivalence.md)
- [Host adapter boundary](docs/HOST_ADAPTER_BOUNDARY.md) — the non-hook recording path

## Development

```bash
corepack pnpm install
corepack pnpm check     # build, typecheck, tests, Phase 0 corpus, evidence traces
```

`pnpm check` is the single definition of correctness; CI runs that same command rather than a
parallel definition of its own. The event protocol carries its own contract corpus —
`node tools/phase0/validate.mjs` checks every fixture against the schemas, with no runtime involved.

### Before pushing, run it on Linux too

CI runs `ubuntu-latest` and `windows-latest`. Development here happens on Windows, so a green
local run is evidence about one of the two legs — and this repository has twice shipped a
commit that was green on Windows and red on Linux, once for weeks without anyone noticing.

```bash
bash tools/ci/check-linux.sh   # runs pnpm check inside WSL against this checkout's HEAD
```

It exits non-zero when the Linux leg fails, so it can gate a push. Setup instructions are at
the top of the script. It does **not** reproduce the GitHub *Windows* runner, which differs
from a developer's Windows box for anything timing-sensitive — a virtualised disk and a loaded
host change `fs.watch` delivery, which is exactly where the last CI failure landed.

## License

MIT
