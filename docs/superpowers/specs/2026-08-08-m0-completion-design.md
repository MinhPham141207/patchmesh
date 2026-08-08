# M0 Completion Design

## Goal

Close the Phase 1 M0 prerequisite gate by making the Phase 0 completion evidence
explicit, reproducible, and committed. This work does not implement any Phase 1
runtime surface.

## Scope

- Record the exact validator, test, hygiene, redaction, placeholder, and runtime
  boundary checks used as M0 evidence.
- Confirm that positive and negative fixtures declare and produce their expected
  outcomes through the existing Phase 0 validator.
- Reconcile roadmap and milestone status so M0 is complete while M1 through M7 and
  the Phase 1 CLI remain planned.
- Verify the evidence from the committed repository state.
- Commit only the intended M0 gate artifacts.

## Evidence Record

The evidence record will contain the verification date, repository revision, exact
commands, observed results, and the following explicit boundary checks:

- Phase 0 corpus validation succeeds.
- The complete Phase 0 test suite passes.
- JSON, Markdown-link, redaction, and placeholder checks pass.
- No tracked `package.json`, `pnpm-workspace.yaml`, `apps/**`, or `packages/**`
  Phase 1 runtime surface exists.
- The committed tree can reproduce the checks without Phase 1 scaffolding.

## Documentation Changes

`docs/PHASE_1_MILESTONES.md` will mark M0 complete and link to its evidence. The
Phase 1 section of `docs/ROADMAP.md` will continue to describe Phase 1 as the next
planned implementation phase. The Phase 0 repair plan will record that its gate
reconciliation and verification steps are complete.

## Non-Goals

- No TypeScript or pnpm workspace.
- No protocol package, adapter, gateway, SQLite store, projection engine, daemon,
  or CLI implementation.
- No Phase 1 or Phase 2 behavior, findings, directives, or performance claims.

## Acceptance Criteria

M0 is complete only when the evidence record is accurate, all listed checks pass,
the documentation is internally consistent, the repository contains no Phase 1
runtime surface, and the resulting artifacts are committed.
