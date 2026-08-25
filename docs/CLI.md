# PatchMesh CLI Target Reference

## 1. Status and Purpose

> **Status:** Phase 1 read commands (`status`, `agents`, `events`, and `graph`) and
> Phase 2 report-only commands (`overlaps`, `stale`, `explain`, and immutable
> `feedback`) are implemented. Lifecycle and enforcement commands remain unavailable.

This document describes the implemented Phase 1 read-only CLI and the planned later
commands. The four Phase 1 commands are backed by the public query services and are
covered by integration tests.

Roadmap placement means that a command is scheduled for a phase; it does not mean the
command is implemented. An unscheduled command requires an explicit roadmap update
before implementation.

The Phase 1 evidence workflow is:

```bash
patchmesh status
patchmesh events --follow
patchmesh graph
```

This is a runnable observation workflow when an existing database is supplied.

The eventual JSON protocol envelope requires `workspaceId`, `worktreeId`, nullable
`agentId`, and nullable `taskId`; examples remain illustrative. Unavailable agent or
task attribution is represented by `null`. Later attribution is an immutable correction event,
not mutation of the original event. See [Event Protocol V1](protocol/events.md) and the
[Threat Model](THREAT_MODEL.md).

---

## 2. Command Roadmap and Availability

| Command | Roadmap placement | Availability |
| --- | --- | --- |
| `status` | Phase 1 - Observe and Replay | Available, read-only |
| `agents` | Phase 1 - Observe and Replay | Available, read-only |
| `events` | Phase 1 - Observe and Replay | Available, read-only |
| `graph` | Phase 1 - Observe and Replay | Available, read-only |
| `recap` | Recorder slice - continuity | Available, read-only, report-only |
| `overlaps` | Recorder slice - recall | Available, read-only, report-only |
| `stale` | Phase 2 - Deterministic Detection | Available, report-only; declines without proxy-recorded evidence |
| `contracts` | Phase 2 - Deterministic Detection | Available, report-only; declines without proxy-recorded evidence |
| `explain` | Phase 2 - Deterministic Detection | Available, read-only, report-only |
| `feedback` | Phase 2 - Deterministic Detection | Available, append-only, report-only |
| `init` | Recorder slice - setup | Available, writes host configuration |
| `doctor` | Recorder slice - setup | Available, read-only; exits non-zero when recording is broken |
| `prune` | Recorder slice - retention | Available, deletes events past a cutoff |
| `start`, `stop` | Unscheduled support designs | Not available |
| `follow`, `inspect` | Unscheduled support designs | Not available |
| `watch` | Deferred dashboard design | Not available |

The detailed unscheduled sections below preserve design work only. They are not MVP
commitments.

---

## 3. Global Usage

```bash
patchmesh <command> [options]
```

### Global options

```text
-h, --help        Show help
-v, --version     Show the installed PatchMesh version
--json            Print machine-readable JSON when supported
--no-color        Disable colored output
--config <path>   Use a custom configuration file
--project <path>  Use a repository other than the current directory
--database <path> Use an existing SQLite event database
```

### Environment variables

```text
PATCHMESH_CONFIG
PATCHMESH_PROJECT
PATCHMESH_PORT
PATCHMESH_LOG_LEVEL
PATCHMESH_NO_COLOR
```

Command-line options take priority over environment variables.

---

# Core Workflow

## `patchmesh init`

**Roadmap placement:** Recorder slice - setup. Available.

Wire PatchMesh into the current Git repository, so its agents start recording.

### Usage

```bash
patchmesh init [options]
```

### Responsibilities

- Verify that the current directory is a Git worktree
- Merge the recorder's host hooks into `.claude/settings.local.json`
- Register the `patchmesh` MCP server in `.mcp.json`
- Add `.patchmesh/` to `.gitignore`

Nothing else is created. The ledger, journal and snapshot under `.patchmesh/` are written by
the recorder on first use; `init` does not pre-create them, so a repository that is configured
but has not been worked in reports honestly as having no events rather than an empty store.

### Hooks installed

| Host event | Binary | Why |
| --- | --- | --- |
| `UserPromptSubmit` | `patchmesh-record` | Turn boundary; gives ordinary work a task |
| `PreToolUse` | `patchmesh-record` | In-flight visibility, before a call finishes |
| `PostToolUse` | `patchmesh-record` | The record of work done |
| `Stop` | `patchmesh-ingest` | Drains the journal into the ledger |
| `SessionEnd` | `patchmesh-ingest` | Drains a session that ended without stopping |

Merging is additive and idempotent. Hooks belonging to other tools are never modified, and
re-running reports `[==]` rather than appending a second copy. PatchMesh's own entries are
replaced only under `--force`.

### Options

```text
--force             Replace PatchMesh's existing hook and server entries
--no-hooks          Skip hook installation and MCP registration
--no-gitignore      Do not modify .gitignore
--json              Machine-readable step outcomes
```

### Example output

```text
[OK] Claude Code hooks in .claudesettings.local.json
[OK] MCP server in .mcp.json
[OK] .patchmesh/ ignored

Restart the agent session so it loads the new hooks, then work normally.
```

Exit code is `0` when configured and `2` when the working directory is not a Git worktree.

---

## `patchmesh start`

**Roadmap placement:** Unscheduled support design. Not available.

Start the PatchMesh daemon, gateway, event collector, and filesystem observers.

### Usage

```bash
patchmesh start [options]
```

### Options

```text
--foreground        Run in the current terminal
--port <number>     Override the configured local port
--log-level <level> Set debug, info, warn, or error
--no-watch          Disable filesystem observation
```

### Example

```bash
patchmesh start --foreground
```

### Expected output

```text
PatchMesh started

Project:  /workspace/example
Daemon:   http://127.0.0.1:7341
Database: .patchmesh/patchmesh.db
Tracking: Claude Code, MCP
```

Starting an already running daemon must not create a duplicate process.

---

## `patchmesh stop`

**Roadmap placement:** Unscheduled support design. Not available.

Stop the local PatchMesh daemon cleanly.

### Usage

```bash
patchmesh stop [options]
```

### Options

```text
--force    Terminate the process if graceful shutdown fails
```

---

## `patchmesh prune`

**Roadmap placement:** Recorder slice - retention. Available. Deletes durable events.

Delete events older than a retention cutoff, keeping causal replay intact.

The ledger is append-only and nothing else removes from it. A recorded call's value decays
fast - recall looks back four hours by default and recap one day - while the file grows with
every session, so retention is a real operation rather than housekeeping.

### Replay safety

Deleting a time prefix can strand a surviving event's `causationId`, and replay fails closed on
a dangling reference: a careless prune turns a large readable ledger into a small unreadable
one. Anything a retained event still points at is therefore kept, transitively - protecting one
ancestor while deleting the event *it* points at would only move the dangling reference one
link back. Retained counts include these, so `removed` is usually smaller than the number of
events older than the cutoff.

Buffered events waiting on a causal parent are dropped, because past the cutoff that parent is
by construction never arriving.

### Usage

```bash
patchmesh prune --older-than <days> --database <path>
```

`--older-than` is required. Deleting history is not something to do because a flag was
forgotten.

### Options

```text
--older-than <days>        Retention cutoff, in whole days (required)
--json                     Print machine-readable output
```

### Example output

```text
Removed 122 event(s) older than 2026-08-20T14:58:17.609Z.
1213 event(s) retained, including any a retained event still depends on.
```

Exit code is `0` whether or not anything was removed. The recorder's own `.patchmesh/*.rejected`
files are not touched by this command.

---

## `patchmesh status`

**Roadmap placement:** Phase 1 - Observe and Replay. Available, read-only.

Show the health and current state of PatchMesh.

### Usage

```bash
patchmesh status [options]
```

### Options

```text
--json    Print machine-readable status
```

### Example output

```text
PatchMesh status

Health:            healthy
Store:             open
Replayable:        true
Events recorded:   1,482
Agents observed:   3
Tasks observed:    2
Null attribution:  3
Coverage:          62% (918/1482 scopes) observational
Coverage gap:      opaque (412) opaque operation effects are not prospectively enumerable
```

---

# Live Observation

## `patchmesh watch`

**Roadmap placement:** Deferred dashboard design. Not available.

Open the live terminal dashboard.

This terminal dashboard concept is deferred by the current roadmap. Its presence in
this target catalog does not make it an MVP commitment.

### Usage

```bash
patchmesh watch [options]
```

### Options

```text
--agent <id>      Show one agent
--task <id>       Filter by task
--events <count>  Number of recent events to display
--no-tui          Print a continuous plain-text stream
--all             Include inactive and completed agents
```

### Example

```bash
patchmesh watch
```

### Example terminal view

```text
PATCHMESH LIVE

AGENT      TASK                   STATUS    CURRENT ACTION
agent-a    Fix login timeout      running   Editing db/pool.ts
agent-b    Add session refresh    running   Running tests
agent-c    Add integration tests  paused    Waiting for API v4

LIVE ACTIVITY

00:03:12  agent-a  READ     src/db/pool.ts
00:03:15  agent-b  READ     src/db/pool.ts
00:03:18  agent-a  EDIT     releaseConnection()
00:03:20  agent-b  TEST     refresh-session.test.ts
00:03:21  patchmesh NOTICE   Same-symbol activity observed
```

### Recommended TUI controls

```text
↑ / ↓      Select agent
Enter      Inspect selected agent
f          Follow selected agent
d          Show current diff
o          Show overlaps
s          Show stale work
q          Exit
```

---

## `patchmesh agents`

**Roadmap placement:** Phase 1 - Observe and Replay. Available, read-only.

List observed agents and their attributed task evidence. M6 does not infer agent
lifecycle status.

Text output leads with a verdict line, orders agents by activity (event count),
and shows short ids; subagents are indented under the parent whose id theirs
truncates. `--json` keeps full ids and stable field order. The last line points
at `patchmesh console` for the fuller view.

### Usage

```bash
patchmesh agents [options]
```

### Options

```text
--agent <id>       Filter by agent
--task <id>        Filter by task attribution
--json             Print machine-readable output
```

### Example

```bash
patchmesh agents --agent agent-a
```

### Example output

```text
2 agents · busiest first
AGENT    TASKS  EVENTS
agent-a  1      12
  ↳ agent-a.sub.b4c2d1e0  1   3
agent-b  -      7
Explore everything: patchmesh console
```

`-` represents unavailable task attribution; JSON output uses `"taskId": null`.

---

## `patchmesh follow`

**Roadmap placement:** Unscheduled support design. Not available.

Stream one agent's observable activity.

This behaves similarly to `docker logs -f`.

### Usage

```bash
patchmesh follow <agent-id> [options]
```

### Options

```text
--since <duration>  Include earlier events, such as 10m or 1h
--type <type>       Filter by event type
--raw               Show minimally formatted, redacted normalized events
--json              Print newline-delimited JSON
```

### Example

```bash
patchmesh follow agent-a
```

### Example output

```text
00:04:02  START   Task: Fix login timeout
00:04:04  READ    src/auth/login.ts
00:04:07  READ    src/db/pool.ts
00:04:11  BASH    npm test -- login-timeout
00:04:17  RESULT  Failed: connection remained checked out
00:04:20  EDIT    src/db/pool.ts::releaseConnection
00:04:25  DIFF    +12 -3
00:04:30  TEST    login-timeout.test.ts passed
```

---

## `patchmesh inspect`

**Roadmap placement:** Unscheduled support design. Not available.

Show detailed state for an agent, task, resource, finding, or decision.

### Usage

```bash
patchmesh inspect <target> [options]
```

### Target formats

```text
agent-a
agent:agent-a
task:fix-login-timeout
file:src/db/pool.ts
symbol:src/db/pool.ts::releaseConnection
finding:fnd-42
decision:dec-42
```

### Options

```text
--history       Include historical state
--dependencies  Show dependency relationships
--events        Include related events
--json          Print machine-readable output
```

### Example

```bash
patchmesh inspect agent:agent-b
```

### Example output

```text
Agent:              agent-b
Agent status:       running
Task:               session-refresh
Task validity:      possibly_stale
Repository:         repo-7
Workspace:          worktree-agent-b
Integration target: main@4f92c1a

Observed dependency:
  Resource:          symbol:src/db/pool.ts::releaseConnection
  Version domain:    repo-7/worktree-agent-b
  Observed version:  git:1a83e9b

Candidate change:
  Version domain:    repo-7/worktree-agent-a
  Candidate version: git:9c21d4e

Finding:             fnd-42
Decision:            dec-42
Coordination action: request_revalidation
Gateway directive:  allow_with_notice
Coverage:            intercepted, verified

Recommended check:
  Revalidate the session-refresh implementation against main@4f92c1a plus the
  candidate change.
```

---

## `patchmesh graph`

**Roadmap placement:** Phase 1 - Observe and Replay. Available, read-only.

Explore the current rebuildable work-graph projection. This command is read-only;
the append-only event log remains the source of truth.

By default it serves the projection as a local page and prints the link. Four days of
work in one repository projects to around a thousand nodes and edges, two thirds of them
content-hash versions - printed as text that is a data dump rather than an answer, so the
terminal gets a link and the page gets the graph.

Nothing is launched for you. The command prints the address and holds the server open; follow
the link when you want it, in whichever browser you want it in. Most terminals make the URL
clickable.

The page is bound to `127.0.0.1` and never to a routable address: a ledger names every file an
agent touched in a private repository. It re-reads the ledger on every request, so leaving the
tab open across an agent session and reloading shows the new work. Press `Ctrl+C` to stop
serving.

### Usage

```bash
patchmesh graph [options]
```

### Options

```text
--agent <id>      Limit the projection to one agent
--task <id>       Limit the projection to one task
--resource <id>   Limit the projection to one resource
--port <n>        Bind this loopback port instead of an ephemeral one
--print           Print the projection as text instead of serving it
--json            Print machine-readable output instead of serving it
```

### What the page shows

- **A stat strip** - events, agents, tasks, files, changes, and the two numbers that matter
  most on a hook-recorded ledger: how many files more than one agent changed, and how many
  changes arrived with no attribution at all.
- **Map** - agents on the left, the files they touched on the right, grouped by directory and
  expandable. Solid links are changes, dashed links are reads, and link weight is the number
  of events behind it. A file is shaded by how many times it changed and outlined when more
  than one agent changed it. Changes with no attribution get a row of their own rather than
  being dropped, so the lines add up to the count above them.
- **Files** - the same data as a sortable table: path, changes, agents, tasks, last touched.
- **A detail panel** - for the selected agent, task, directory or file. A file shows its full
  change history: when, by whom, what kind of change, and the before and after content hashes
  the version nodes carry.

Selecting anything dims everything it did not touch. `/` focuses the filter, `Escape` clears
the selection.

### Terminal output

```text
Work graph at http://127.0.0.1:52413
Reading /repo/.patchmesh/ledger.db

Open the link above when you want it. The page re-reads the ledger on reload,
so it stays current while you work. Press Ctrl+C to stop serving.
```

`--print` renders the projection as text instead, naming nodes by path:

```text
WORK GRAPH (2 agent, 215 resource, 41 task, 696 version; 1244 edge(s))

agent   agent_7a1033a6-93c4-46e2-a83c-c471f26765c2
resource        packages/query/src/services.ts
version packages/query/src/services.ts@2e6f071c
```

---

# Coordination Inspection

## `patchmesh recap`

**Roadmap placement:** Recorder slice - continuity. Available, read-only, report-only.

What previous sessions did here: tasks, spans, call counts, files changed, and the commits each
task landed.

This is the surface that pays off first, and the one to start with. It returns real value on a
single agent working alone and needs no concurrency at all, which is the workflow almost every
reader actually has - `overlaps` needs two agents running at once before it can say anything.

It is the same answer the `patchmesh_recap` MCP tool gives an agent, rendered for a person.
Deliberately one implementation: the recap's wording is the product of measuring what an agent
needed in order to resume instead of re-deriving, and a person reading a terminal needs the
same things. Two renderings would drift, and the CLI's would be the one nobody measured.

### Bounds

A recap is a summary, so it is bounded twice: in how many tasks it describes and in how much it
says about each. An unbounded recap is just the ledger again, and re-reading the ledger is not
cheaper than re-reading the code. Defaults are one day back and five tasks; both truncations
are reported rather than silent.

### Usage

```bash
patchmesh recap [--within <minutes>] [--limit <n>] [--agent <id>] [--json]
```

### Options

```text
--within <minutes>         How far back to look (default 1440, one day)
--limit <n>                How many tasks to describe (default 5, maximum 25)
--agent <id>               Narrow to one agent's work
--metrics                  Report time to resume instead of the recap itself
--json                     Print machine-readable output
```

### Example output

```text
3 recent task(s) in this repository, most recent first:
- task_c2f162a4-6c09-4341-a5f0-5d16b4e95e6b
  agent_c460874d-db62-471e-a101-d2791ce85c48, 2026-08-23T03:12:59.094Z to 2026-08-23T03:17:28.865Z, 13 call(s)
  changed: README.md, apps/cli/src/args.ts, apps/cli/src/main.ts (+3 more)
  committed: Bind observed changes to the calls that caused them
(40 older task(s) not shown.)
61 call(s) belong to no task and are not summarized here.
This is what was done, not what it means. A changed file is not a finished intention.
```

Calls belonging to no task are counted and declared rather than folded into somebody else's
task. `committed:` is a timing claim, not a statement of purpose: a task may land no commits or
several, and one commit may carry work from several tasks.

---

## `patchmesh overlaps`

**Roadmap placement:** Recorder slice - recall. Available, read-only and report-only.

Show files that more than one worker changed recently, from observed filesystem changes.

This answers from recorded `file.changed` events rather than from the work-graph projection.
It previously read persisted `same_symbol_overlap` findings, which on a host-hook-recorded
ledger are never produced - shell commands record as opaque, so the projection emits coverage
gaps instead of overlaps. The same question was already answered for agents over MCP by
`patchmesh_overlapping_work`; both surfaces now call one implementation.

### What counts as an overlap

Three conditions, all required:

- **Two distinct workers.** A different agent, a subagent running beside its parent, or a
  second worktree of the same repository. One agent's own consecutive turns are sequence, not
  contention, and are not reported. A change with no attribution is not a participant either:
  an unknown worker is not a distinct one.
- **Both were in flight.** The earlier writer must still have been making calls after the later
  one wrote. If it had stopped, the second was building on settled work, which is what
  collaboration looks like — that is reported as a count of sequential files, not as contention.
- **A file the repository tracks.** Paths `.gitignore` covers are excluded, so another tool's
  cache is not reported as contested work.

Without the second condition the answer was a function of `--within` rather than of the work:
on this repository's own ledger the old rule gave 0 overlaps at 30 minutes, 9 at two hours, and
20 at anything from eight hours out — of which 13 were sequential edits to popular files.
Precision against a labelled corpus of real recorded rows went from about 0.35 to 1.0. The gate
that holds it there runs in `pnpm check`; see
[docs/measurements/overlap-precision.md](measurements/overlap-precision.md).

Each reported file carries a `why:` line naming the two writes and the moment the earlier worker
was last active, so the claim can be checked rather than taken on trust.

### Usage

```bash
patchmesh overlaps [options]
```

### Options

```text
--resource <path>          Narrow to one repository-relative file
--within <minutes>         How far back to look (default 240)
--json                     Print machine-readable output
```

### Example

```bash
patchmesh overlaps --within 480 --database .patchmesh/ledger.db
```

### Example output

```text
1 file(s) in this repository were changed by two workers at once:
- `packages/gateway/src/server.ts` — two workers in flight, across 2 task(s) that changed it:
    - 2026-08-22T07:46:13.891Z agent_b48c1c15 (task_771fe0be) modified
    - 2026-08-22T07:12:04.220Z agent_7a1033a6.sub.a79bd1f2 (task_a79bd1f2) modified
    why: agent_7a1033a6.sub.a79bd1f2 wrote at 2026-08-22T07:12:04.220Z and was still working
         at 2026-08-22T07:58:11.006Z, after agent_b48c1c15 wrote at 2026-08-22T07:46:13.891Z.
4 further file(s) were changed by two workers in sequence and are not reported as contention.
This is a record of what happened, not a judgement. Both workers were in flight over the same
file, which is not the same as saying either is wrong.
```

When nothing is contested, three answers stay distinct: "no two workers changed the same file
at once", the count of files they changed *in sequence*, and "no file changes were observed at
all". The last is an absence of evidence, not evidence of independence — and the middle one is
why a file you know two people edited can correctly report as uncontested.

---

## `patchmesh stale`

**Roadmap placement:** Phase 2 - Deterministic Detection. Available, read-only and report-only.

Show persisted stale-read-before-write findings. This does not confirm Phase 3
validity state or execute a revalidation.

### Evidence this detector requires

`stale` is typed against evidence a host-hook recorder does not produce: `file.read` and `write.dependent` events. When the
event store contains none of it, the command reports which evidence is missing and exits `0`
rather than printing "no findings" - silence and inability are different answers, and reporting
no findings would be a claim it has not earned. Recording through an MCP proxy that declares
read and dependency evidence populates it.

### Usage

```bash
patchmesh stale [options]
```

### Options

```text
--json             Print machine-readable output
```

### Example output

```text
TASK              STATUS           REASON
Login frontend    possibly_stale   Built against POST /login v3
```

Confirmed `stale` status and validity history depend on Phase 3 and are not
available in the Phase 2 target.

---

## `patchmesh contracts`

**Roadmap placement:** Phase 2 - Deterministic Detection. Available, report-only.

Show persisted exported-contract-invalidation findings: a changed exported contract whose
consumers may no longer hold. This reports; it does not revalidate a consumer or change
validity state.

### Evidence this detector requires

`contracts` is typed against evidence a host-hook recorder does not produce: `symbol.changed` and `dependency.changed` events. When the
event store contains none of it, the command reports which evidence is missing and exits `0`
rather than printing "no findings" - silence and inability are different answers, and reporting
no findings would be a claim it has not earned. Recording through an MCP proxy that declares
read and dependency evidence populates it.

### Usage

```bash
patchmesh contracts [options]
```

### Options

```text
--json                     Print machine-readable output
```

### Example output

```text
No contracts findings can be derived from this event store.
Missing evidence: symbol.changed, dependency.changed.
```

---

## `patchmesh explain`

**Roadmap placement:** Phase 2 - Deterministic Detection. Available, read-only and report-only.

Explain a persisted report-only PatchMesh decision, including its finding, deliveries,
immutable feedback-event history, and coverage warnings. Phase 2 never emits a
disruptive gateway directive.

### Usage

```bash
patchmesh explain <decision-id> [options]
```

### Options

```text
--json      Print machine-readable output
```

### Example

```bash
patchmesh explain dec-42
```

### Example output

```text
Decision:            dec-42
Finding:             fnd-42
Target agent:        agent-b
Target task:         session-refresh
Confidence:          high
Coordination action: request_revalidation
Gateway directive:  allow_with_notice

Reason:
  Agent B used authenticate() from repo-7/worktree-agent-b at git:1a83e9b.
  Agent A proposed git:9c21d4e from repo-7/worktree-agent-a.
  Agent B is modifying a direct caller.

Integration target:
  main@4f92c1a

Dependency path:
  authenticate()
  -> login-handler.ts
  -> task:session-refresh

Coverage:
  intercepted, verified

Recommended check:
  Recheck the implementation and rerun login tests against the candidate change.
```

---

## `patchmesh feedback`

**Roadmap placement:** Phase 2 - Deterministic Detection. Available, append-only and report-only.

Record an immutable response to a persisted finding. This never changes the original
finding or decision, and a dismissal is separate from usefulness feedback.

### Usage

```bash
patchmesh feedback <finding-id> --disposition <value> [--decision <decision-id>] \
  [--useful true|false] [--reason <text>] [--agent <agent-id>] [--task <task-id>] [--json]
```

`--disposition` is required and accepts `dismissed`, `acknowledged`,
`not_affected`, `already_handled`, or `needs_more_information`. The command derives
the response’s causal provenance from the stored finding and rejects a supplied
decision that does not belong to that finding.

### Example

```bash
patchmesh feedback finding_123 --disposition dismissed --useful true \
  --reason "Already handled in my branch" --agent agent_a --task task_a
```

---

## `patchmesh delivery`

**Roadmap placement:** Phase 2 - Deterministic Detection. Available, append-only and report-only.

Record an immutable delivery-state transition for a persisted decision. The command
derives the target and causal provenance from that decision; it cannot change the
decision, its policy action, or its gateway directive.

### Usage

```bash
patchmesh delivery <decision-id> --state <pending|delivered|acknowledged|failed> [--json]
```

---

# Event and Debug Commands

## `patchmesh events`

**Roadmap placement:** Phase 1 - Observe and Replay. Available, read-only.

Inspect recorded activity. The default text output folds each tool call — a
`tool.requested` and its `tool.completed`, plus the `file.changed` events it
caused — into one readable row, newest first, capped at the 20 most recent
calls. It opens on a verdict line naming the totals and ends by pointing at
`patchmesh console` for the full stream.

### Usage

```bash
patchmesh events [options]
```

### Options

```text
--agent <id>        Filter by agent
--task <id>         Filter by task
--type <event-type> Filter by event type
--since <duration>  Show recent events
--until <time>      Set an ending timestamp
--limit <number>    Cap the calls shown (default 20)
--cursor <event-id> Resume after an event cursor
--follow            Continue streaming new events
--raw               One line per raw event, as scripts expect
--json              Print newline-delimited JSON
```

`--raw`, JSON, and newline-delimited JSON never bypass secret redaction.

### Example output

```text
4212 calls · 10269 events recorded · showing the newest 20, 4192 older withheld
08:51:37  -                -      -> opencode.json.backup
06:55:10  agent_15d4c4eb   Write  Write apps/cli/src/main.ts -> apps/cli/src/main.ts
Explore everything: patchmesh console
```

### Examples

```bash
patchmesh events --agent agent-a --since 10m
patchmesh events --type file.changed --follow
```

### Common event types

```text
tool.requested
tool.completed
file.read
file.changed
symbol.read
symbol.changed
task.completed
dependency.changed
evidence.derived
attribution.corrected
finding.created
decision.created
validity.changed
decision.delivery.changed
```

---

## `patchmesh doctor`

**Roadmap placement:** Recorder slice - setup. Available, read-only.

Check whether PatchMesh is actually recording in this repository.

Both hook binaries always exit `0` by design - a recorder that can break an agent session gets
uninstalled - so every failure is silent, and every silent failure looks exactly like an idle
repository. Hooks that were never loaded, a global install missing its recorder binary, and a
repository nobody has worked in yet all present the same way: an empty ledger and no
explanation. This command is the other half of failing open. It changes nothing; it says which
of those states the repository is in.

It never requires, and never creates, the ledger it is diagnosing - the most useful moment to
run it is before one exists.

Alone among the read commands, `doctor` does **not** drain the journal before it answers. Every
report freshens first so it describes now rather than the last time a session stopped; `doctor`
is the one whose subject *is* the undrained journal, and freshening would erase the backlog it
exists to report.

### Usage

```bash
patchmesh doctor [--json]
```

### Checks

```text
node        The runtime can open the event store at all (node:sqlite needs Node 24+)
repository  A git worktree was found, and whether it is a linked one
hooks       PatchMesh's hooks are present in .claude/settings.local.json
recorder    The binaries those hooks name actually resolve on this machine
mcp         The patchmesh MCP server is registered in .mcp.json
gitignore   .patchmesh/ is kept out of version control
ledger      The ledger exists, how many events it holds, how large it is, and how recent
            they are. Warns past 64MiB: nothing prunes on its own, and the fix is named
            rather than taken, because retention deletes history and history is the product
journal     Entries waiting to be drained, interrupted drains, unrepresentable entries
```

A hook command whose path the host expands (`$CLAUDE_PROJECT_DIR/...`) is reported as
unverified rather than broken. Claiming a failure that cannot be demonstrated sends people to
reinstall something that was never wrong.

### Example output

```text
[OK] node: v24.15.0
[OK] repository: D:\patchmesh
[OK] hooks: all 5 hooks installed
[OK] mcp: MCP server registered in .mcp.json
[OK] gitignore: .patchmesh/ is ignored
[OK] ledger: 3241 event(s) in D:\patchmesh\.patchmesh\ledger.db, 7.4MB, latest 2026-08-23T03:17:28.865Z
[OK] journal: 108 entr(ies) waiting for the next drain

PatchMesh is recording.
```

### Exit code

`0` when nothing is broken, `3` when something is. This is the one report whose exit code
carries the answer: every other command exits `0` when it has successfully reported bad news,
which is correct for a report and useless for a health check meant to gate anything.

Warnings do not make the exit code non-zero. A configured repository with no ledger yet has
nothing wrong with it.

---

# Exit Codes

PatchMesh commands should use stable exit codes.

```text
0   Success
1   General failure
2   Invalid command or arguments
3   PatchMesh is not initialized
4   Daemon is unavailable
5   Configuration is invalid
6   Requested agent, task, or event was not found
7   Reserved for Phase 4 policy enforcement; unavailable in Phases 0-3
8   Required observability was unavailable, so the operation could not complete
9   Internal storage or replay failure
```

Commands that successfully report warnings or degraded coverage exit with `0`. Exit
code `8` applies only when required observability is unavailable and the requested
operation therefore cannot complete.

---

# Output Rules

## Human-readable output

Default terminal output should:

- Use concise labels
- Highlight severity clearly
- Explain disruptive decisions
- Avoid dumping full tool payloads
- Redact secrets
- Use stable IDs for agents, findings, and decisions

## JSON output

Commands supporting `--json` should return stable structured data suitable for scripts.

Example:

```json
{
  "schemaVersion": 1,
  "findingId": "fnd-42",
  "decisionId": "dec-42",
  "agentId": "agent-b",
  "taskId": "session-refresh",
  "agentStatus": "running",
  "taskValidity": "possibly_stale",
  "integrationTarget": "main@4f92c1a",
  "coordinationAction": "request_revalidation",
  "gatewayDirective": "allow_with_notice",
  "coverage": ["intercepted", "verified"],
  "reasons": [
    {
      "dependency": "symbol:src/db/pool.ts::releaseConnection",
      "observedVersion": {
        "domain": "repo-7/worktree-agent-b",
        "value": "git:1a83e9b"
      },
      "candidateVersion": {
        "domain": "repo-7/worktree-agent-a",
        "value": "git:9c21d4e"
      }
    }
  ]
}
```

This is an illustrative CLI envelope, not a finalized protocol schema. Unknown task
attribution is represented as `"taskId": null`.

## Secret handling

PatchMesh must redact:

- API keys
- Access tokens
- Passwords
- Authorization headers
- Private environment values
- Credentials embedded in command output

---

# Later and Unscheduled Command Concepts

The following concepts are not available and are not scheduled Phase 1 or Phase 2
commands:

```text
patchmesh replay
patchmesh claims
patchmesh tasks
patchmesh adapters
patchmesh config
patchmesh export
patchmesh benchmark
```

`claims` depends on measured enforcement. A second runtime adapter belongs to Phase
5 expansion. The remaining concepts require explicit roadmap placement before
implementation.

---

# Roadmap-Required CLI Design Gaps

The roadmap requires these user interactions, but their CLI shape is not yet
designed. They are obligations, not available commands:

- Phase 3: inspect validity history and recommended checks.
- Phase 3: link revalidation results to decisions and show the proof required for a
  confirmed `stale` status.

Do not invent or implement commands for these interactions without a focused design
and an explicit roadmap-compatible update to this reference.

# Documentation Rule

The CLI implementation and this document must not drift apart.

Prefer generating command usage and options from the same command definitions used by:

```bash
patchmesh --help
```

When a command changes, update:

1. Command implementation
2. Help output
3. Tests
4. This document
5. README quick-start instructions when relevant
