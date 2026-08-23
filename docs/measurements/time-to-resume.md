# Time to resume — the pre-injection baseline

**Frozen 2026-08-23 at commit `16502a0`, before any `SessionStart` hook existed.**

This file exists because the measurement it records cannot be taken again. Time-to-resume is
the control arm for every value claim PatchMesh makes. The moment a `SessionStart` hook starts
injecting a recap into every session, every recorded session is a treated session, and the
un-instrumented baseline is gone permanently. See
[PM-10](../problems/PM-10-invariant-rests-on-a-counterfactual.md) and
[ORDER.md](../problems/ORDER.md).

## What is measured

Calls an agent makes before its first observed `file.changed`.

Everything before that first change is orientation — reading, searching, working out where the
last session stopped. Orientation is exactly what a recap is supposed to displace, so it is
the honest denominator for whether recap is worth its own cost.

Unlike the displacement measure PM-10 A wants, this needs **no counterfactual**. It does not
ask what the agent would have read. It asks only what the agent did, and both sides are
already in the ledger.

## The baseline

```
Median:            83 calls
Agents measured:   7
Never changed:     6
Events read:       2,194   (tool.requested + file.changed)
Ledger total:      3,781 events, 18 agents, 61 tasks
Window:            2026-08-18T12:45:01Z to 2026-08-23T07:41:47Z
```

Per agent, longest first:

| Agent | Calls before first change |
| --- | --- |
| `agent_b48c1c15` | 175 |
| `agent_2478f630` | 141 |
| `agent_0509e795` | 84 |
| `agent_62225cb8` | 83 |
| `agent_6e6c8445` | 77 |
| `agent_c460874d` | 61 |
| `agent_50717d23` | 36 |

Six further agents made calls (3 to 156) and never changed a file. They are excluded from the
median rather than counted as zero: "never resumed" and "resumed immediately" are opposite
results, and averaging them together would erase both.

The full record, including agent ids and timestamps, is in
[`time-to-resume-baseline.json`](time-to-resume-baseline.json).

## How to recompute it

```
patchmesh recap --metrics
patchmesh recap --metrics --json
```

Subagents are excluded by default. A subagent is spawned to do one specific thing and starts
changing files almost immediately, so counting them drags the median toward zero and flatters
the number. The measure is about resuming a session, and a subagent does not resume anything.

## How to read it after the hook lands

Once `SessionStart` injects a recap, this command measures the **treatment**, not the baseline.
Compare a post-injection median against the 83 recorded above. The claim PatchMesh wants to be
able to make is that the median falls, and that it falls by more than the injected context
costs.

Two things that would invalidate a naive comparison, and should be checked before believing one:

- **Sample composition.** Seven agents is a small sample from one developer on one repository.
  A post-injection median drawn from a different mix of task types is not comparable.
- **The six agents that never changed anything.** If injection converts some of those into
  agents that do change something, they enter the median as new low values and the median
  falls without any session having resumed faster. Report `measuredAgents` alongside the
  median, always.
