# PM-18 — Nothing budgets the ledger, and nothing ever mentions it

- **Status:** `resolved` 2026-08-25
- **Severity:** low

## The problem

Measured on this repository, 2026-08-25: **8,522 events in 19.2MB**, or roughly **2.2KB an
event**, accruing about **2,300 events a day** from a single developer.

`patchmesh prune --older-than <days>` has existed since retention landed. It has never been
run, here or anywhere, because nothing ever suggests it. `doctor` reported the event count and
the latest timestamp and said nothing about size, so the number a user would act on was not on
the screen during the months in which acting is still cheap.

At the observed rate a real team's ledger is a gigabyte inside a quarter. The window cache that
makes `recap` fast is sized for windows, not for that, and `doctor` and `status` both read
every event to answer.

## The fix

`doctor` now reports the ledger's size unconditionally, so growth is visible before it is a
problem:

```text
[OK] ledger: 8824 event(s) in D:\patchmesh\.patchmesh\ledger.db, 19.1MB, latest 2026-08-25T04:34:48.043Z
```

Past `LEDGER_LARGE_BYTES` (64MiB — about a month at the observed rate) it becomes a `warn` that
names the command:

```text
[WARN] ledger: ... — nothing prunes the ledger on its own
       fix: drop history you no longer need: patchmesh prune --older-than 30
```

## Why it is a warning and not a job

Retention deletes history, and history is the product. A tool that quietly drops what it was
trusted to remember is worse than a large file, and `prune` already refuses to run without an
explicit `--older-than` for the same reason. The choice stays with the person.

It is also a `warn` rather than a `fail` because `doctor`'s exit code gates other things: size
must not be able to turn a recording repository into a broken one.

## What it does not fix

Nothing here reduces the 2.2KB an event, which is the actual driver. The canonical event blob
is stored per event with its own JSON; that is the number to attack if this ever becomes
pressing, and this change only makes it visible.
