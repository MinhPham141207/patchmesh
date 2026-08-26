# OpenCode envelope evidence

Provenance: `captured-parts.json` holds 53 real tool records from two live OpenCode
sessions in this repository on 2026-08-26 (`ses_fc283860…`, the user's capture session,
and `ses_fc27ee113…`). They were extracted from OpenCode's own persisted session store
(`part` rows), not from a plugin hook — the probe plugin never fired because every
candidate instance had booted before it existed. Each record is rendered in the
`tool.execute.after` shape the plugin API documents (`{ tool, sessionID, callID }`,
input args, result). The exact wrapper the hook hands a plugin (argument positions,
pre-call shape) is still unverified; what is evidenced is every field the adapter needs.

## What the records establish

| Question | Finding |
| --- | --- |
| Tool vocabulary | Lowercase built-ins observed: `bash`, `edit`, `write`, `read`, `grep`, `glob` |
| Session identity | Every record carries `sessionID` (`ses_…`) — per-call attribution exists |
| Call identity | Every record carries a `callID`, unique per call |
| Arguments | `state.input`: bash → `{command}`, edit → `{filePath, oldString, newString}`, write → `{filePath, content}`, read → `{filePath, offset?, limit?}`, grep → `{pattern, path?, include?}` (all three captures carry `path`), glob → `{pattern}` only — no capture shows glob carrying `path`, so its `path`-property mapping in the tool table is plausible-but-unverified |
| Outcomes | `state.status`: `completed` (also `error` possible per docs) |
| Path property for edits/writes | `filePath` |
| Subagent/delegate naming | NOT answered by this capture — no delegate id appears in tool parts. F-01 §10 question 2 stays open at the adapter level |

## Consequences for the adapter

- Tier: **observed** stands — per-tool-call interception with session identity.
- Tool table: lowercase names; file tools key on `filePath`; grep keys on its optional
  `path`; glob is tabled with the same optional `path`, but no capture evidences one -
  plausible-but-unverified, revisit if a glob capture ever carries it. Unrecognized →
  `other` opaque.
- Subagent calls cannot be named yet; all work attributes to the session agent. Recorded
  as residual risk, not papered over.
