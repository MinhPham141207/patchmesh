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
| `overlaps` | Recorder slice - recall | Available, read-only, report-only |
| `stale` | Phase 2 - Deterministic Detection | Available, report-only; declines without proxy-recorded evidence |
| `contracts` | Phase 2 - Deterministic Detection | Available, report-only; declines without proxy-recorded evidence |
| `explain` | Phase 2 - Deterministic Detection | Available, read-only, report-only |
| `feedback` | Phase 2 - Deterministic Detection | Available, append-only, report-only |
| `init` | Recorder slice - setup | Available, writes host configuration |
| `prune` | Recorder slice - retention | Available, deletes events past a cutoff |
| `start`, `stop` | Unscheduled support designs | Not available |
| `follow`, `inspect`, `doctor` | Unscheduled support designs | Not available |
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

Health:            degraded
Store:             open
Replayable:        true
Events recorded:   1,482
Agents observed:   3
Tasks observed:    2
Null attribution:  3
Coverage:          degraded
Coverage gap:      opaque tool effects
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
ID        TASKS                 EVENTS
agent-a   task-login            12
agent-b   -                     7
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

Inspect the current rebuildable work-graph projection. This command is read-only;
the append-only event log remains the source of truth.

### Usage

```bash
patchmesh graph [options]
```

### Options

```text
--agent <id>      Limit the projection to one agent
--task <id>       Limit the projection to one task
--resource <id>   Limit the projection to one resource
--json            Print machine-readable output
```

### Example output

```text
WORK GRAPH

Coverage:           degraded
Coverage gap:       opaque tool effects

agent:agent-b
  -> task:session-refresh
     -> symbol:src/db/pool.ts::releaseConnection
```

---

# Coordination Inspection

## `patchmesh overlaps`

**Roadmap placement:** Recorder slice - recall. Available, read-only and report-only.

Show files that more than one worker changed recently, from observed filesystem changes.

This answers from recorded `file.changed` events rather than from the work-graph projection.
It previously read persisted `same_symbol_overlap` findings, which on a host-hook-recorded
ledger are never produced - shell commands record as opaque, so the projection emits coverage
gaps instead of overlaps. The same question was already answered for agents over MCP by
`patchmesh_overlapping_work`; both surfaces now call one implementation.

### What counts as an overlap

Two conditions, both required:

- **Two distinct workers.** A different agent, a subagent running beside its parent, or a
  second worktree of the same repository. One agent's own consecutive turns are sequence, not
  contention, and are not reported.
- **A file the repository tracks.** Paths `.gitignore` covers are excluded, so another tool's
  cache is not reported as contested work.

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
1 file(s) in this repository changed by more than one task:
- `packages/gateway/src/server.ts` changed by 2 tasks:
    - 2026-08-22T07:46:13.891Z agent_b48c1c15 (task_771fe0be) modified
    - 2026-08-22T07:12:04.220Z agent_7a1033a6.sub.a79bd1f2 (task_a79bd1f2) modified
This is a record of what happened, not a judgement. Two tasks touching one file may be
collaboration, a rebase, or divergence.
```

When nothing is contested, "no two tasks changed the same file" and "no file changes were
observed at all" are reported as different answers. The second is an absence of evidence, not
evidence of independence.

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

Inspect recorded normalized events.

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
--limit <number>    Limit returned events
--cursor <event-id> Resume after an event cursor
--follow            Continue streaming new events
--raw               Show full normalized fields with secrets redacted
--json              Print newline-delimited JSON
```

`--raw`, JSON, and newline-delimited JSON never bypass secret redaction.

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

**Roadmap placement:** Unscheduled support design. Not available.

Check whether PatchMesh can reliably observe the repository and configured runtimes.

### Usage

```bash
patchmesh doctor [options]
```

### Options

```text
--fix     Apply safe automatic fixes
--json    Print machine-readable diagnostics
```

### Checks

```text
Git repository
Configuration validity
Daemon availability
Database access
Runtime hook installation
MCP proxy configuration
Filesystem watcher
Git diff collection
Tree-sitter parsers
Event ingestion
Agent identity propagation
Tool bypass risk
Log directory permissions
```

### Example output

```text
PATCHMESH READINESS

[OK] Git repository detected
[OK] Configuration loaded
[OK] SQLite database writable
[OK] Claude Code hooks installed
[OK] Filesystem watcher active
[OK] Agent IDs present in tool events
[WARN] Direct shell access may bypass tool-level intent tracking
[WARN] Coverage is degraded: shell effects are verified after execution
```

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
