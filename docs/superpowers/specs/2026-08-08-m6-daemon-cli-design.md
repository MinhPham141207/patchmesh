# M6 Read-Only Daemon Services and CLI Design

**Date:** 2026-08-08
**Status:** Approved design

## Goal

Implement Phase 1 milestone M6, `Read-Only Daemon Services and CLI`, on top of the
completed protocol, SQLite event store, observation boundary, and M5 work-graph
projection.

M6 makes observed and projected state usable through stable public queries. It remains
read-only, replayable, and report-only. It must not introduce Phase 2 findings,
decisions, validity claims, disruptive directives, or unscheduled lifecycle commands.

## Scope

M6 includes:

- A shared `patchmesh-query` public read-service package.
- An `apps/daemon` composition layer with health and read-service wiring.
- An `apps/cli` executable and command parser.
- `patchmesh status`, `patchmesh agents`, `patchmesh events`, and `patchmesh graph`.
- Deterministic human output, JSON output, and newline-delimited event JSON.
- Agent, task, event-type, time, limit, and graph-resource filters defined below.
- Redaction for every output mode, including raw event output.
- Coverage state and explicit degraded-coverage warnings.
- Cursor-based event pages and `events --follow` with deterministic polling behavior.
- Fixture-database integration tests and M6 completion evidence.

M6 does not include:

- `init`, `start`, `stop`, `watch`, `follow`, `inspect`, or `doctor` commands.
- HTTP, WebSocket, RPC, or other daemon transport.
- Database creation, migration commands, or write APIs.
- Overlap, stale, explain, detector, policy, decision, or validity output.
- Agent lifecycle inference such as running, paused, waiting, or completed status.
- A dashboard, second runtime adapter, graph persistence, or new event type.

## Architecture

### `patchmesh-query`

Create a public read-service package that depends on `patchmesh-protocol` and
`patchmesh-storage`. It must not import CLI, daemon, adapter, or observation runtime
code.

The package exposes:

```ts
export interface ReadServices {
  getStatus(): StatusView;
  listAgents(filters?: AgentFilters): AgentsView;
  listEvents(query?: EventListQuery): EventPage;
  getGraph(filters?: GraphFilters): GraphView;
  followEvents(options: FollowOptions, signal?: AbortSignal): AsyncIterable<EventPage>;
}
```

Services consume an injected event-store reader and M5 projection function. They do not
query SQLite tables directly. All returned records are defensive, redacted DTOs and
must not expose mutable storage or projection state.

### `apps/daemon`

The daemon package provides composition only:

```ts
export interface PatchMeshDaemon {
  readonly services: ReadServices;
  readonly health: () => DaemonHealth;
  close(): void;
}

export function createDaemon(options: DaemonOptions): PatchMeshDaemon;
```

`createDaemon` receives an already selected database path or injected event-store
reader, opens the existing store, and wires `patchmesh-query` to M5 projection state.
It does not create missing databases, start a process, listen on a port, or register an
adapter. `close` releases the store and stops no external process.

### `apps/cli`

The CLI parses only the four scheduled commands and invokes `PatchMeshDaemon.services`
in-process. The executable may accept an explicit `--database <path>` for fixture and
local use; a missing path or missing database is an unavailable-store error. The CLI
does not open SQLite tables or call storage internals beyond the daemon/service
composition boundary.

## Phase 1 DTOs

### Status

`StatusView` contains only:

- daemon health: `healthy`, `degraded`, or `unavailable`;
- store state and replayability;
- total observed event count and counts by event type;
- unique non-null agent count;
- unique non-null task count;
- event count with null agent or task attribution;
- aggregate coverage presentation, modes, and explicit gaps; and
- a sanitized error category when health is degraded or unavailable.

It does not contain active agents, running tasks, paused tasks, overlaps, stale state,
findings, decisions, validity, policy, or gateway directives.

### Agents

`AgentsView` contains observed agent records derived from event envelopes:

- stable `agentId`;
- sorted observed task IDs, which may include `null`;
- observed event count;
- sorted event-type counts; and
- coverage summaries associated with the agent's observed events.

Agents are not labeled running, paused, waiting, or completed because the Phase 1
event set has no agent lifecycle contract. A null task attribution remains `null` in
JSON and is rendered as `-` only in human output.

### Events

`EventPage` contains:

- redacted normalized event records;
- `nextCursor`, the ID of the last scanned event in durable insertion order; and
- whether more records are available for a bounded page.

Event service filters are:

```ts
interface EventListQuery {
  readonly agentId?: AgentId;
  readonly taskId?: TaskId | null;
  readonly eventType?: EventType;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly cursor?: EventId;
}
```

Event pages use the event store's insertion order. Timestamps filter records but never
establish causal order. A missing cursor returns a typed cursor error; the service does
not silently restart from an arbitrary position.

### Graph

`GraphView` contains the M5 `WorkGraphSnapshot` plus the applied graph filter and
coverage warnings. Graph filtering preserves stable node, edge, evidence, version,
and coverage ordering. An agent filter retains matching agent relationships; a task
filter retains matching task relationships; a resource filter retains matching resource,
version, dependency, and related activity relationships. Filtering never invents
detector findings or dependency impact.

## Command Contracts

### `patchmesh status`

```text
patchmesh status [--database <path>] [--json]
```

Human output uses stable labels and includes health, event count, attribution counts,
replayability, and coverage presentation/gaps. Degraded coverage is a warning, not a
command failure. JSON output is one stable object.

### `patchmesh agents`

```text
patchmesh agents [--database <path>] [--agent <id>] [--task <id>] [--json]
```

Human output is a stable table sorted by agent ID. JSON output contains the same records
and explicit null task values. Unsupported target-catalog filters `--active`,
`--runtime`, and `--status` are rejected with a usage error rather than inferred.

### `patchmesh events`

```text
patchmesh events [--database <path>] [--agent <id>] [--task <id>]
  [--type <event-type>] [--since <time>] [--until <time>] [--limit <number>]
  [--cursor <event-id>] [--follow] [--raw] [--json]
```

Human output is sorted durable event order. `--json` emits one redacted event-page
record per line in stable NDJSON form. `--raw` changes field presentation only; it
never bypasses redaction. `--follow` emits the initial page, then polls for appended
events using the internal cursor without duplicates.

### `patchmesh graph`

```text
patchmesh graph [--database <path>] [--agent <id>] [--task <id>]
  [--resource <id>] [--json]
```

Human output uses stable node and edge sections followed by coverage warnings. JSON
output contains the filtered graph snapshot and coverage. It does not show integration
targets, findings, decisions, validity, overlap labels, or stale labels.

## Follow Semantics

`followEvents` performs one initial read, records the last scanned event ID, and polls
for newly appended events at a fixed implementation-defined interval. The interval is
not exposed as a lifecycle or daemon configuration command in M6.

For each poll:

1. Read the current insertion-ordered event list.
2. Locate the internal cursor; if it is absent, return the typed cursor error.
3. Scan only events after the cursor.
4. Apply the requested filters and redaction.
5. Advance the cursor across both matching and nonmatching events.
6. Yield matching records, or wait for the next poll when none match.

An `AbortSignal` ends the iterator without an error. CLI SIGINT maps to normal exit
`0`. Store close, read failure, or cursor failure terminates the iterator with a typed
error and deterministic nonzero CLI exit code. No event is emitted twice by one
iterator instance.

## Redaction and Exit Codes

All service DTOs pass through a single recursive redaction boundary before rendering.
Secret-shaped keys and values include API keys, tokens, passwords, authorization
headers, credentials, private environment values, and secret-bearing diagnostics.
Redaction applies equally to human output, JSON, NDJSON, and `--raw`. The CLI never
prints raw executor errors, environment dumps, or credentials.

Use deterministic exit categories:

- `0`: successful query, including degraded coverage warnings and normal follow shutdown;
- `2`: invalid command, unsupported option, malformed filter, or invalid limit/time;
- `3`: missing database/configuration or unavailable store;
- `4`: corrupt event, replay failure, or cursor failure;
- `130`: explicit non-follow interruption if the host maps it separately; follow SIGINT
  uses `0` as specified above.

## Error Handling

The query package returns typed errors with sanitized categories and no raw event values.
Status converts store/replay failures into unavailable or degraded health with the error
category. Events and graph return command failures and no partial DTO. Agents returns no
partial list when its source replay fails. Read services never mutate events, append
events, run tools, deliver decisions, create stores, or apply migrations.

## Verification

Tests use temporary SQLite databases and real M5 replay/projection behavior. They cover:

- service DTO shape and Phase 1 field limits;
- status attribution and degraded-coverage aggregation;
- agent/task filters and null attribution;
- event type/time/limit filters and insertion-order cursors;
- graph filters and stable ordering;
- human, JSON, and NDJSON output;
- recursive redaction in normal and raw output;
- initial follow page, cursor resume, filter-aware polling, duplicate suppression,
  missing cursor, store failure, abort, and shutdown;
- CLI integration and deterministic exit codes; and
- rejection of unscheduled commands and Phase 2-only fields.

Completion verification runs focused query/daemon/CLI tests, the full workspace suite,
recursive typechecks and builds, Phase 0 validation/tests, and `git diff --check`.
M6 evidence records command results, public DTO behavior, follow semantics, redaction,
coverage limitations, and explicit M7/Phase 2 deferrals.
