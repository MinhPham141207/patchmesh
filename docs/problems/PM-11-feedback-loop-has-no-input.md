# PM-11 — The feedback loop has no input

- **Status:** `blocked` (on PM-05 **and PM-13**)
- **Severity:** low

## The problem

`patchmesh feedback` exists, with five dispositions (`dismissed`, `acknowledged`,
`not_affected`, `already_handled`, `needs_more_information`), and takes a `--finding-id`.

The ledger contains **zero** `finding.created` events. It always has. There is nothing to
give feedback about, so the command is a loop with nothing entering it. The same is true of
`explain <decision-id>` and `delivery`: zero `decision.created`, zero
`decision.delivery.changed`.

## Re-labelled 2026-08-24 — also blocked on PM-13

This file names PM-05 as the blocker: no `finding.created` events, so nothing to give feedback
about. That is true and it is not the whole reason.

Even with findings, feedback needs somebody to receive one and respond. Agents called the MCP
surface **14 times in the ledger's entire life** ([PM-13](PM-13-pull-is-zero-and-the-recap-suppresses-it.md)),
against 152 calls to the memory server in the same sessions. A feedback loop attached to a
surface that is asked once per ~395 events does not have a sample problem; it has a traffic
problem.

Producing findings is necessary. It is not sufficient, and building PM-05 first on the theory
that feedback follows would produce findings nobody is in a position to respond to.

## Why it matters

Three of the fifteen CLI commands are wired to an event class the system has never produced.
The delivery plan treats feedback collection as the mechanism that turns dogfooding into a
labelled corpus; that mechanism has never run.

## Candidate solutions

### A. Produce findings from the detector that can work — recommended

`overlaps` computes contention today and prints it as prose. Persisting each as a
`finding.created` gives `feedback` its first real input and makes overlap findings
reviewable rather than re-derived on every query.

- Depends on nothing that does not already work.
- Needs a stable finding identity, so the same contention does not create a new finding on
  every invocation.

### B. Automatic usefulness signal instead of explicit feedback

Rather than asking, observe: did the agent act on the file the answer named, within the same
turn? That is a disposition without anyone typing one.

- No human in the loop, so it actually accumulates.
- Weaker signal — action is not endorsement.

### C. Leave the commands and document them as awaiting findings

- Free. They currently fail cleanly rather than lying, which is acceptable.

## Recommendation

A, once PM-05's analyzer work gives `contracts` findings too. B is worth adding alongside,
because explicit feedback from a single-developer dogfood will never reach useful volume.
