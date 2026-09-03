# Features

One file per proposed capability, numbered `F-nn`. A feature file carries the ask, what the
current code makes easy or hard, the design, what it deliberately does not do, and a delivery
order with acceptance criteria.

This directory is the counterpart to [docs/problems](../problems/): a problem file describes
something that is wrong now, a feature file describes something that does not exist yet. When a
feature is delivered, its file keeps the original design and gains a "what shipped" section, the
same convention the problem files use.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `proposed` | Designed and sequenced, not started. |
| `accepted` | Committed to a version; work has begun. |
| `partial` | Some waves shipped; the file states which. |
| `shipped` | Delivered. The file records what landed and what changed from the design. |
| `dropped` | Not being built. The file keeps the reasoning, so it is not re-proposed. |

## Register

| # | Feature | Status | Target |
| --- | --- | --- | --- |
| [F-01](F-01-multi-host-agent-workspace.md) | The multi-host agent workspace — host adapters, mailbox, roles, performance | `design-reviewed` | 0.3.0 / 0.4.0 |
