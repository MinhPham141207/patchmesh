import { workerKey } from "patchmesh-query";
import type { OverlappingTask } from "patchmesh-query";

/**
 * A labeled corpus for the file-level contention rule, drawn from this repository's own ledger.
 *
 * Unlike `detector-quality-corpus.ts`, which is synthetic and says so, every positive and every
 * sequential negative below is a real row observed on 2026-08-23 across 3,781 recorded events.
 * The agent ids, timestamps and paths are verbatim. That matters because the thing being scored
 * is a judgement about *real working patterns* -- whether two coding sessions were in flight
 * over one file -- and a synthetic case cannot be wrong about that in an interesting way.
 *
 * Why this corpus exists at all: `findOverlappingWork` is the only detector in PatchMesh that
 * fires on hook-recorded data, and until now it was the only one with no precision measure. The
 * existing quality gate scores `same_symbol_overlap`, which needs the proxied `McpProxy` path
 * and has never fired on real traffic. The machinery was pointed at a detector that never runs.
 *
 * The labels are the author's, and the rule for assigning them is stated so they can be argued
 * with: a case is a **positive** when the earlier writer was still making calls after the later
 * writer changed the file, because neither was then working from a settled version. It is a
 * **negative** when every writer had stopped before the next one wrote, because that is
 * ordinary sequential collaboration and reporting it is what made the command cry wolf.
 */
export interface OverlapCorpusCase {
  readonly caseId: string;
  /** Why this label is right, so a reader can disagree with the label rather than guess at it. */
  readonly note: string;
  readonly expectedContention: boolean;
  readonly tasks: readonly OverlappingTask[];
  /** Last observed activity per worker, keyed by the rule's own `workerKey`. */
  readonly lastActiveByWorker: ReadonlyMap<string, string>;
}

export const overlapCorpusVersion = "field-v1";

/** The single worktree every recorded event in this corpus was observed in. */
const WT = "wt_b169f6f5-b19d-5ad0-a8ab-0f48448673d5";

const A_2478 = "agent_2478f630-4707-4f79-a9b9-448c934ddadb";
const A_6E6C = "agent_6e6c8445-9416-481d-8367-d938a4deb521";
const A_C460 = "agent_c460874d-db62-471e-a101-d2791ce85c48";
const A_B48C = "agent_b48c1c15-5de3-4702-8bf8-906e0715f597";
const A_6222 = "agent_62225cb8-9250-4387-9d9a-6f724994b9c9";
const A_0509 = "agent_0509e795-14ec-4c97-8f5b-ada1ab62d88b";

function task(taskId: string, agentId: string | null, at: string, worktreeId: string | null = WT): OverlappingTask {
  return { taskId, agentId, at, changeKind: "modified", worktreeId };
}

/**
 * Keys built with the rule's own `workerKey` rather than by reproducing its format.
 *
 * Reconstructing it by hand here scored the whole corpus as negative on the first run --
 * precision 1.0, recall 0.0 -- because the separator did not match and every lookup missed.
 * A corpus that can silently miss is worse than no corpus.
 */
function active(entries: readonly (readonly [string, string])[]): ReadonlyMap<string, string> {
  return new Map(entries.map(([agentId, at]) => [workerKey(agentId, WT), at] as const));
}

/**
 * Observed last-activity for the agents that appear below, verbatim from the ledger.
 * Shared across cases because it is a property of the session, not of the file.
 */
const OBSERVED_ACTIVITY = active([
  [A_B48C, "2026-08-22T07:47:17.174Z"],
  [A_6222, "2026-08-22T15:18:04.471Z"],
  [A_2478, "2026-08-22T19:26:37.604Z"],
  [A_6E6C, "2026-08-23T02:51:44.702Z"],
  [A_C460, "2026-08-23T03:17:00.000Z"],
  [A_0509, "2026-08-23T06:47:56.026Z"],
]);

export const overlapCorpus: readonly OverlapCorpusCase[] = [
  // ---- Positives: two sessions genuinely in flight over one file. ----
  {
    caseId: "field-v1-readme-two-sessions",
    note:
      "agent_2478f630 wrote README.md at 16:21 and was still making calls at 19:26, an hour "
      + "after agent_6e6c8445 wrote the same file at 19:19. Both sessions were open over it.",
    expectedContention: true,
    tasks: [
      task("task_0bb449ec-74ff-4d48-9b92-0d3c165632a3", A_2478, "2026-08-22T16:21:30.353Z"),
      task("task_84cff6b6-afe5-4505-922b-fc4b2e10c90e", A_6E6C, "2026-08-22T19:19:56.857Z"),
    ],
    lastActiveByWorker: OBSERVED_ACTIVITY,
  },
  {
    caseId: "field-v1-effects-two-sessions",
    note:
      "The same two sessions over packages/recorder/src/effects.ts. This is the pair that was "
      + "independently recorded as genuine two-agent contention when it happened.",
    expectedContention: true,
    tasks: [
      task("task_aa0c992a-9ef3-4a81-8043-97d3a6cecd8d", A_2478, "2026-08-22T18:28:15.880Z"),
      task("task_84cff6b6-afe5-4505-922b-fc4b2e10c90e", A_6E6C, "2026-08-22T19:07:07.173Z"),
    ],
    lastActiveByWorker: OBSERVED_ACTIVITY,
  },
  {
    caseId: "field-v1-cli-test-two-sessions",
    note:
      "A different pair on apps/cli/test/cli.test.ts: agent_6e6c8445 wrote at 01:50 and was "
      + "still working at 02:51, after agent_c460874d wrote at 02:16.",
    expectedContention: true,
    tasks: [
      task("task_bdcd6537-faff-498c-a44e-fee221d48343", A_6E6C, "2026-08-23T01:50:03.801Z"),
      task("task_da4a5484-8850-42e6-b8d0-03f6e8f6aed4", A_C460, "2026-08-23T02:16:37.618Z"),
    ],
    lastActiveByWorker: OBSERVED_ACTIVITY,
  },

  // ---- Negatives: real sequence. These are the rows the old rule reported as overlaps. ----
  {
    caseId: "field-v1-effects-test-sequence",
    note:
      "agent_b48c1c15 finished at 07:47; agent_2478f630 wrote the file eleven hours later. "
      + "The second was building on settled work, which is what collaboration looks like.",
    expectedContention: false,
    tasks: [
      task("task_seq_b48c", A_B48C, "2026-08-22T05:57:11.643Z"),
      task("task_aa0c992a-9ef3-4a81-8043-97d3a6cecd8d", A_2478, "2026-08-22T18:28:15.880Z"),
    ],
    lastActiveByWorker: OBSERVED_ACTIVITY,
  },
  {
    caseId: "field-v1-gateway-index-four-workers-in-sequence",
    note:
      "packages/gateway/src/index.ts was written by four different sessions over two days, and "
      + "every one of them had stopped before the next began. Four workers is not four "
      + "collisions -- this is the case that most clearly showed the old rule counting "
      + "popularity rather than contention.",
    expectedContention: false,
    tasks: [
      task("task_seq_gw_1", A_B48C, "2026-08-22T07:46:13.891Z"),
      task("task_seq_gw_2", A_6222, "2026-08-22T13:51:29.032Z"),
      task("task_seq_gw_3", A_2478, "2026-08-22T18:28:15.880Z"),
      task("task_seq_gw_4", A_0509, "2026-08-23T05:35:30.206Z"),
    ],
    lastActiveByWorker: OBSERVED_ACTIVITY,
  },
  {
    caseId: "field-v1-recap-sequence-with-repeat-writers",
    note:
      "packages/gateway/src/recap.ts, where two of the writers each wrote twice. Repeated "
      + "writes by one worker must not manufacture contention with themselves.",
    expectedContention: false,
    tasks: [
      task("task_seq_rc_1", A_B48C, "2026-08-22T07:46:13.891Z"),
      task("task_seq_rc_2", A_6222, "2026-08-22T11:52:59.178Z"),
      task("task_seq_rc_3", A_6222, "2026-08-22T15:08:24.677Z"),
      task("task_seq_rc_4", A_2478, "2026-08-22T16:21:30.353Z"),
      task("task_seq_rc_5", A_2478, "2026-08-22T18:28:15.880Z"),
    ],
    lastActiveByWorker: OBSERVED_ACTIVITY,
  },

  // ---- Structural negatives: shapes the rule must never call contention. ----
  {
    caseId: "field-v1-one-worker-consecutive-turns",
    note:
      "One session's own two turns. A session runs one task at a time, so this is sequence by "
      + "construction. This exact shape was eight out of eight false positives once already.",
    expectedContention: false,
    tasks: [
      task("task_own_a", A_6E6C, "2026-08-23T01:50:03.801Z"),
      task("task_own_b", A_6E6C, "2026-08-23T02:39:55.253Z"),
    ],
    lastActiveByWorker: OBSERVED_ACTIVITY,
  },
  {
    caseId: "field-v1-unattributed-second-writer",
    note:
      "A change with no agent and no worktree could belong to either party, so counting it as "
      + "a second participant would invent the very thing being reported.",
    expectedContention: false,
    tasks: [
      task("task_attributed", A_2478, "2026-08-22T16:21:30.353Z"),
      task("task_unattributed", null, "2026-08-22T18:00:00.000Z", null),
    ],
    lastActiveByWorker: OBSERVED_ACTIVITY,
  },
  {
    caseId: "field-v1-boundary-finished-exactly-at-the-later-write",
    note:
      "The earlier worker's last activity is the same instant as the later write. Treated as "
      + "finished, not as contending: an inclusive boundary would make every hand-off where one "
      + "session ends as another begins into a collision.",
    expectedContention: false,
    tasks: [
      task("task_boundary_a", A_B48C, "2026-08-22T05:57:11.643Z"),
      task("task_boundary_b", A_6222, "2026-08-22T07:47:17.174Z"),
    ],
    lastActiveByWorker: OBSERVED_ACTIVITY,
  },
];
