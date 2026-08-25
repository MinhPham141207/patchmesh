# Changelog

All notable changes to PatchMesh are recorded here. Versions are shared across every package
in the workspace, so a version number identifies one state of the whole product.

## 0.2.0 — 2026-08-25

Two problems found by re-judging the product against its own live ledger rather than against
its test suite, which was green throughout both.

### Fixed

- **Every report answered about the last `Stop`, not about now.** The recorder journals each
  call immediately but ingest ran on `Stop`, so a session's own work reached the readable side
  only after that session ended. Measured live: the ledger's latest event was **fourteen hours
  behind** a journal written to that morning, and `overlaps` reported "no file changes in the
  last 4h" on a day of continuous work. Reports now drain the journal before reading. Free
  when nothing is pending (0.13-0.97ms), bounded at 500 entries, and fail-open — a stale
  answer beats no answer. `doctor` deliberately abstains, because the undrained journal is
  exactly what it exists to report. See `docs/problems/PM-17`.
- **The work-graph projection had gone quadratic again**, and `patchmesh status` took **41
  seconds** on a 8,824-event ledger. `toolCoverage` found a call's observed reads by filtering
  every event in the ledger, once per call; `mergeEvidence` re-sorted a node's entire evidence
  list on every touch, and hot nodes reach 1,639 entries. Both are now indexed or deferred to
  the one sort the snapshot already did. **`projectWorkGraph` 16,934ms -> 1,295ms** on the same
  frozen 8,931-event set, with the serialised snapshot **byte-for-byte identical**. Guarded by
  a scaling test verified to fail on the unfixed code. See `docs/problems/PM-19`.
- **`doctor` loaded the entire ledger to count it**, parsing and validating every event to
  learn two numbers. It now asks SQLite. About 6,064ms -> 252ms.
- **The first report on a fresh install said nothing had been recorded** while a journal full
  of calls sat beside it. The recorder creates the ledger on its first *drain*, and the "no
  ledger" verdict was reached before any drain could happen. Reports now freshen before that
  check, so a new user's first `recap` answers from the session that just ran.

### Added

- **`freshenLedger`** (`patchmesh-recorder`) — the drain-before-read step above, exported so a
  host embedding PatchMesh can make its own reads current.
- **`SqliteEventStore.latestTimestamp()`** — the companion to `count()`, served by the existing
  `events(timestamp)` index.
- **`doctor` reports the ledger's size** and warns past 64MiB, naming `patchmesh prune` rather
  than running it. Retention deletes history and history is the product, so the choice stays
  with the person; it is a warning rather than a failure because `doctor`'s exit code gates
  other things. See `docs/problems/PM-18`.

### Changed

- **The filesystem walk is off the path agents call.** Observing effects stats and
  content-hashes every tracked file, costing 681-949ms *even when it finds nothing*, and a CPU
  profile of it is 54% idle — it is I/O bound and scales with the checkout. Folding it into
  every read was a 10x regression on the MCP surface before it was caught. It is now opt-in:
  the CLI reports and the `SessionStart` hook take it, the MCP tools do not, and `Stop` remains
  the unthrottled path that binds changes to the calls that caused them. Over stdio,
  `patchmesh_recap` is **63ms warm** and `patchmesh_recent_activity` **7ms**.
- **An invalid command gets a three-line hint** instead of the full forty-line usage dump, and
  an unsupported option now points somewhere instead of failing bare.

### Known limitations

Unchanged from 0.1.2, and still worth restating: the `PreToolUse` advisory does not reach the
model, `stale` and `contracts` cannot fire on a hook-only install, and coverage is
observational. Two more, measured this release:

- **Adoption of the MCP tools is one call per 183.** 17 calls across 3,105 attributed tool
  calls, 6 of 28 sessions. The `SessionStart` injection is, in practice, the whole product.
- **Time-to-resume has not yet beaten its own baseline.** Control 83.5 calls, treatment 91.5,
  and the treatment arm is still under five sessions — `recap --metrics` says so itself rather
  than claiming a win.

## 0.1.2 — 2026-08-25

The first release in which PatchMesh says something *before* a write rather than only after
one, and the first in which its own precision claim can fail.

### Added

- **A contention advisory, delivered in three stages.** On `UserPromptSubmit` it names the
  files other workers already have in flight, before the turn's first tool call. On
  `PostToolUse` it reports a path-scoped collision one call after the write. A `PreToolUse`
  stage is built and kept but does not yet reach the model — see *Known limitations*. All
  three ride hooks `patchmesh init` already installs; none adds a process spawn.
- **`patchmesh_active_work`** — a new MCP tool answering who is working right now *and*
  whether recording is live, so an empty answer can be told from a broken one. Every other
  tool reports history, where "nothing found" and "nothing recorded" look identical.
- **Live contention in `patchmesh_overlapping_work`.** It read only the ledger, and ingest
  runs on `Stop`, so every overlap it reported was necessarily a post-mortem. It now also
  reads the journal and reports what is open *now*, listed apart from historical overlaps
  because they are different claims.
- **`tools/concurrency`** — a harness that manufactures real, labelled concurrent-write data
  through the real recorder pipeline, into an isolated scratch ledger. It confirms
  `IDLE_GAP_MINUTES` is inclusive at exactly 30.

### Changed

- **Machine-readable output is bounded.** `--json` dumped every projection coverage gap and
  grew with the ledger without limit: `agents --json` was 1.3 MB, `status` and `contracts`
  522 KB each, of which 522,203 bytes were 2,611 per-event gap objects. Now sampled with
  `gapsTotal`, `gapsByKind` and `gapsWithheld` beside it. Fields keep their names and element
  types, so a consumer reading `gaps[0]` still works — it is now a page that says so.
- **Detector output answers the question first.** `contracts` printed a table header with no
  rows, then every coverage gap, then `No findings` last. The verdict now leads and the gaps
  sit under it as a caveat. A zero over complete coverage reads as a clean result; a zero over
  incomplete coverage says it is an absence of evidence rather than evidence of absence.
- **The observation boundary waits for the watcher to go quiet** rather than for a fixed span.
  `endWindow` slept `quiescenceMs` once and finalized, which bet that every watcher event
  arrived inside a fixed window; `fs.watch` delivery is bounded by nothing. Late events landed
  after the drain cursor and degraded windows that had been observed correctly.

### Fixed

- **The overlap precision gate could not fail.** Its corpus assigned labels by the detector's
  own timing rule, so precision 1.0 measured conformance rather than validity. Relabelled from
  `file.changed` content hashes, which are independent of that rule: honest precision is
  **0.667** on n=8. One hash-verified clean handoff is flagged by the detector, recorded for
  whoever next revisits `IDLE_GAP_MINUTES`.
- **`contracts` was documented as unavailable while working.** The help said it needed
  proxy-recorded evidence. Ingest derives `symbol.changed` and `dependency.changed` itself and
  runs on a hook `init` wires, so an ordinary install has produced them since 2026-08-23.
- **Adoption is counted from the ledger**, not from `answers.ndjson`, which drifted in both
  directions and could not distinguish a benchmark probe from real use.
- The gateway's heavy dependencies load on first tool call rather than at handshake.

### Known limitations

Stated because a product that hides these is harder to trust than one that does not.

- **The `PreToolUse` advisory does not reach the model.** Claude Code's `PreToolUse` has no
  non-blocking channel to the agent: `allow`'s reason is shown to the user only, and `deny` and
  `ask` both block. Delivery therefore runs one call late through `PostToolUse`, plus the
  turn-start notice. The `PreToolUse` path is kept, unmodified, for a host that gains one.
- **Contention has a very small sample.** Seven real cases, from a single pair of agents.
  Every threshold here rests on that, which is why `tools/concurrency` exists.
- **`patchmesh stale` cannot run on a hook-only install.** It is typed against `file.read` and
  `write.dependent`, which host hooks do not produce. It says so rather than returning zero.
- **Coverage is observational.** Roughly 90% of recorded shell calls carry no path, so effects
  bind to calls by time window, and the answer says when it could not.

### Breaking

- `OverlapResult` gains a required `live` field. Code that *reads* an overlap result is
  unaffected; code that *constructs* one must add it.

## 0.1.1 — 2026-08-22

First working release on npm: hook-based recording, the event ledger, `recap`, `doctor`,
`init`, and the `patchmesh_recent_activity` / `patchmesh_overlapping_work` / `patchmesh_recap`
MCP tools.

## 0.1.0 — 2026-08-22

Initial publish.
