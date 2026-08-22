# patchmesh

A shared work ledger for coding agents and their subagents.

Agents write to it implicitly, by working through a host hook. They read from it
deliberately — to find out what has already been done and what is being done right now, so
they do not repeat it or collide with it.

```bash
npm install -D patchmesh @patchmesh/recorder @patchmesh/gateway
npx patchmesh init
```

`init` merges the recorder's hooks into `.claude/settings.local.json`, registers the
`patchmesh` MCP server in `.mcp.json`, and adds `.patchmesh/` to `.gitignore`. It is additive
and idempotent: hooks belonging to other tools are never touched, and a second run reports
what is already configured rather than appending a duplicate. Restart the agent session so it
loads the hooks, then work normally.

Afterwards:

```bash
npx patchmesh status               # store health, counts, observation coverage
npx patchmesh events               # the durable event page
npx patchmesh overlaps             # files more than one worker changed
npx patchmesh prune --older-than 30
```

Agents get the same ledger back over MCP as `patchmesh_recent_activity`,
`patchmesh_overlapping_work`, and `patchmesh_recap`.

## What it records

A Claude Code `PostToolUse` hook journals every tool call — including the built-in `Read`,
`Edit`, `Write`, and `Bash` that no MCP server can see — and the worktree is captured per turn
and diffed, so a file written by a shell command is recorded even though the command named no
path. Measured overhead is p50 108ms per call. Both binaries always exit 0: a recorder that
can break your agent gets uninstalled after one incident.

## What it does not do

PatchMesh reports. No command pauses, rejects, or redirects an agent.

Its `stale` and `contracts` detectors cannot fire on hook-recorded data — they are typed
against read and dependency evidence a host hook does not produce — and say so rather than
reporting "no findings". Overlap detection is implemented and correct but has not been
exercised against genuinely concurrent work. See the repository README for the full list of
what is and is not proven.

Requires Node 24 or newer: the event store is built on `node:sqlite`.

[Repository](https://github.com/minhpham141207/patchmesh) ·
[Issues](https://github.com/minhpham141207/patchmesh/issues) · MIT
