# PM-11 — The feedback loop has no input

- **Status:** `blocked` (on PM-05)
- **Severity:** low

## The problem

`patchmesh feedback` exists, with five dispositions (`dismissed`, `acknowledged`,
`not_affected`, `already_handled`, `needs_more_information`), and takes a `--finding-id`.

The ledger contains **zero** `finding.created` events. It always has. There is nothing to
give feedback about, so the command is a loop with nothing entering it. The same is true of
`explain <decision-id>` and `delivery`: zero `decision.created`, zero
`decision.delivery.changed`.

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
