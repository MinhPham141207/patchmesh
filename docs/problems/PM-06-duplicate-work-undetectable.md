# PM-06 — Duplicate work, the founding claim, is undetectable

- **Status:** `blocked` (on content evidence or task semantics)
- **Severity:** high

## The problem

PatchMesh was framed as a layer that manages what agents and subagents do "so they do not
repeat each other's work". That detector does not exist and cannot be built on what is
recorded.

Running the query against real data showed why: three `edit_file` calls against
`DELIVERY_PLAN.md` within 90 seconds were one agent making three different edits to three
different sections. Repetition is not duplication. A detector keyed on `(toolName,
targetResourceId)` cannot tell "same file, different change" from "same work done twice",
because the recorded `operation` field is a redacted descriptor (`Edit <path>`), not the
content or the intent of the change.

## Why it matters

This is the claim in the product's own framing. Every other feature is instrumentation in
service of it. It is currently unshipped, unmeasured, and unbuildable as recorded.

## Candidate solutions

### A. Content hash per changed file at ingest — recommended

Two agents whose changes produce the same resulting content did the same work. That is a
direct observation, not an inference.

- Also serves PM-04 (disambiguation) and rework detection. One change, three problems.
- Detects convergent output, not convergent intent — two agents solving one bug differently
  still read as distinct. That is a real limit, not a defect.
- Storage cost is one hash per `file.changed`; 592 events so far.

### B. Capture the prompt via `UserPromptSubmit`

Redacted prompt text gives tasks semantics. Two tasks with near-identical prompts are
candidate duplicates before either has written anything.

- The only option that catches duplication *early*, which is the only time it is worth
  catching.
- Prompts are the most sensitive text in the system. The `redact.ts` whitelist would have to
  be extended deliberately, and the privacy question answered explicitly, not by default.
- Similarity scoring means either a dependency or a crude heuristic.

### C. Diff capture rather than hash

Record the actual change, not a fingerprint of the result.

- Strictly more informative than A.
- Substantially more storage, and the redaction problem gets much harder — a diff is source
  code, and source code contains secrets.

### D. Declare duplication out of scope and rewrite the framing

Lead with continuity, which is demonstrated, and stop claiming duplicate detection.

- Honest and free. It gives up the product's most distinctive claim.

## Recommendation

A now, because it is cheap and shared across three problems. B is the real answer, and it
should not be started until the privacy question has an explicit decision behind it.
