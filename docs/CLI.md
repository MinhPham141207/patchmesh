# PatchMesh CLI Reference

## 1. Purpose

The PatchMesh CLI provides local setup, runtime control, live agent observation, coordination inspection, and troubleshooting.

The primary workflow is:

```bash
patchmesh init
patchmesh start
patchmesh watch
```

This document defines the intended MVP command surface. A command should only be marked as available once it is implemented.

---

## 2. Global Usage

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

Initialize PatchMesh in the current Git repository.

### Usage

```bash
patchmesh init [options]
```

### Responsibilities

- Verify that the current directory is a Git repository
- Create the local PatchMesh directory
- Create the default configuration
- Initialize the event database
- Detect supported coding-agent runtimes
- Offer or install required runtime hooks
- Add local PatchMesh state to `.gitignore`

### Expected files

```text
.patchmesh/
├─ patchmesh.db
├─ state/
└─ logs/

patchmesh.config.json
```

### Options

```text
--force             Replace existing generated configuration
--runtime <name>    Configure a specific runtime
--no-hooks          Skip runtime hook installation
--no-gitignore      Do not modify .gitignore
```

### Example

```bash
patchmesh init --runtime claude-code
```

### Expected output

```text
[OK] Git repository detected
[OK] Created .patchmesh/
[OK] Created patchmesh.config.json
[OK] Initialized SQLite event store
[OK] Installed Claude Code hooks

Run:
  patchmesh start
```

---

## `patchmesh start`

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

## `patchmesh status`

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

Daemon:          running
Project:         /workspace/example
Active agents:   3
Running tasks:   2
Paused tasks:    1
Open overlaps:   1
Possibly stale:  2
Events recorded: 1,482
```

---

# Live Observation

## `patchmesh watch`

Open the live terminal dashboard.

This is the main PatchMesh user interface.

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
00:03:21  patchmesh WARNING  Work convergence detected
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

List active and recent agents.

### Usage

```bash
patchmesh agents [options]
```

### Options

```text
--active           Show only active agents
--runtime <name>   Filter by runtime
--task <id>        Filter by task
--status <status>  Filter by status
--json             Print machine-readable output
```

### Example

```bash
patchmesh agents --active
```

### Example output

```text
ID        RUNTIME       TASK                  STATUS
agent-a   claude-code   Fix login timeout     running
agent-b   claude-code   Add session refresh   running
agent-c   codex         Add auth tests        paused
```

---

## `patchmesh follow`

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
--raw               Show raw normalized events
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
Agent:      agent-b
Runtime:    claude-code
Task:       Add session refresh
Status:     possibly_stale
Worktree:   .patchmesh/worktrees/agent-b

Current footprint:
  Reading:
    src/session/refresh.ts
    src/db/pool.ts

  Modifying:
    src/session/refresh.ts

Dependencies:
  db/pool.ts::releaseConnection at version 12

Warning:
  Current version is 13 after agent-a's edit.

Required action:
  Revalidate the session-refresh implementation.
```

---

# Coordination Inspection

## `patchmesh overlaps`

Show active and historical overlap findings.

### Usage

```bash
patchmesh overlaps [options]
```

### Options

```text
--active                   Show unresolved overlaps only
--agent <id>               Filter by agent
--type <type>              Filter by overlap type
--min-confidence <level>   Use low, medium, or high
--severity <level>         Filter by severity
--json                     Print machine-readable output
```

### Overlap types

```text
harmless
complementary
duplicate
conflicting
dependency
```

### Example

```bash
patchmesh overlaps --active
```

### Example output

```text
HIGH  agent-a ↔ agent-b

Type:
  duplicate

Shared resource:
  src/db/pool.ts::releaseConnection

Evidence:
  agent-a is modifying the symbol
  agent-b requested an edit to the same symbol
  both tasks reference a database connection leak

Decision:
  agent-a retains ownership
  agent-b should continue with validation tests
```

---

## `patchmesh stale`

Show running or completed work that may no longer be valid.

### Usage

```bash
patchmesh stale [options]
```

### Options

```text
--agent <id>       Filter by agent
--task <id>        Filter by task
--confirmed        Show confirmed stale work only
--possible         Show possibly stale work only
--json             Print machine-readable output
```

### Example output

```text
TASK              STATUS           REASON
Login frontend    possibly_stale   Built against POST /login v3
Auth docs         stale            Documents removed response field
```

---

## `patchmesh explain`

Explain a PatchMesh finding or decision.

Every disruptive decision must be explainable.

### Usage

```bash
patchmesh explain <id> [options]
```

### Options

```text
--events    Include supporting event history
--graph     Include the relevant dependency path
--json      Print machine-readable output
```

### Example

```bash
patchmesh explain dec-42
```

### Example output

```text
Decision:   Request revalidation
Target:     agent-b
Confidence: high

Reason:
  Agent B read authenticate() at version 12.
  Agent A changed authenticate() to version 13.
  Agent B is modifying a direct caller.

Dependency path:
  authenticate()
  → login-handler.ts
  → Login frontend task

Required action:
  Recheck the implementation and rerun login tests.
```

---

# Event and Debug Commands

## `patchmesh events`

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
--follow            Continue streaming new events
--raw               Show full event payloads
--json              Print newline-delimited JSON
```

### Examples

```bash
patchmesh events --agent agent-a --since 10m
patchmesh events --type file.changed --follow
```

### Common event types

```text
agent.registered
agent.disconnected

task.assigned
task.started
task.blocked
task.completed

tool.requested
tool.completed
tool.failed

file.read
file.write_intended
file.changed

symbol.read
symbol.changed

test.started
test.completed

dependency.changed
discovery.reported

finding.created
decision.created
decision.resolved
```

---

## `patchmesh doctor`

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
[WARN] Codex adapter is not configured
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
7   Operation was blocked by policy
8   Observability is degraded
9   Internal storage or replay failure
```

Commands that only report warnings should normally still exit with `0`.

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
  "agentId": "agent-b",
  "taskId": "session-refresh",
  "status": "possibly_stale",
  "reasons": [
    {
      "dependency": "src/db/pool.ts::releaseConnection",
      "readVersion": 12,
      "currentVersion": 13
    }
  ]
}
```

## Secret handling

PatchMesh must redact:

- API keys
- Access tokens
- Passwords
- Authorization headers
- Private environment values
- Credentials embedded in command output

---

# MVP Command Set

The initial CLI should contain:

```text
patchmesh init
patchmesh start
patchmesh stop
patchmesh status
patchmesh watch
patchmesh agents
patchmesh follow
patchmesh inspect
patchmesh overlaps
patchmesh stale
patchmesh explain
patchmesh events
patchmesh doctor
```

The essential first-run experience is:

```bash
patchmesh init
patchmesh start
patchmesh watch
```

---

# Planned Commands

These commands should remain in the roadmap until implemented:

```text
patchmesh graph
patchmesh replay
patchmesh claims
patchmesh tasks
patchmesh adapters
patchmesh config
patchmesh export
patchmesh benchmark
```

Do not document planned commands as available.

---

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
