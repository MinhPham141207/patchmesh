# Changelog

All notable changes to PatchMesh are recorded here. Versions are shared across every package
in the workspace, so a version number identifies one state of the whole product.

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
