import { workerKey } from "patchmesh-query";
import type { OverlappingTask, WorkerActivity } from "patchmesh-query";

/**
 * A labeled corpus for the file-level contention rule, drawn from this repository's own ledger.
 *
 * ## Why `field-v2` was retired
 *
 * `field-v2` assigned labels by the rule "a case is a positive when the earlier writer was
 * still working when the later writer changed the file" -- which is `contentionAmong`'s own
 * rule, verbatim. Precision 1.0 / recall 1.0 against that corpus was a tautology: it confirmed
 * the code implements the rule it was written to implement, and said nothing about whether the
 * rule tracks real contention. `docs/problems/PM-02` cited that number as "the signal is now
 * calibrated", which the corpus never supported. A gate whose labels are the thing under test
 * cannot fail, and a gate that cannot fail is not a gate.
 *
 * ## `field-v3`: labels from an independent signal
 *
 * Every `file.changed` event carries `beforeVersion` and `afterVersion`, each a `content_hash`
 * over the file's real bytes at that instant, recorded by the observer independently of anything
 * `contentionAmong` reads. That gives an outcome a timing heuristic cannot: for two writes to one
 * file by different agents, did the later write's `beforeVersion` equal the earlier write's
 * `afterVersion`? If it did, the later writer built on exactly what the earlier one left --
 * whatever the timing looked like, nothing was lost. If it did not, something else reached the
 * file first: a real divergence, verified from content rather than inferred from silence.
 *
 * `overlapCorpus` below now holds only cases where that independent check applies: two distinct
 * agents, a shared file, and a verified hash comparison on both sides. Every entry carries the
 * two full digests and the caseId of whatever in the file's real history sits between them, so
 * the label can be checked against the ledger rather than taken on trust. This is `evaluateOverlapQuality`'s
 * corpus, and it is deliberately small -- see the module doc there for what n=8 does and does not support.
 *
 * The cases that cannot be checked this way -- one worker's own consecutive turns, an
 * unattributed second writer, and the constructed shapes that pin `IDLE_GAP_MINUTES` at its
 * boundary -- are real regression value, but they are not field evidence, because there is no
 * independent signal for them to agree or disagree with. They live in
 * `detectorBehaviorRegressionCases` below, kept for exactly what they are: a description of what
 * `contentionAmong` is specified to do, not a measurement of whether that specification is right.
 * Folding them into the same array as the hash-verified cases is what made `field-v2` look bigger
 * and more field-validated than it was.
 *
 * ## What the hash check found
 *
 * Of the three pairs `field-v1`/`field-v2` called positive, two check out under content hashes
 * (README.md, `packages/recorder/src/effects.ts`: the compared writes are not adjacent in the
 * file's real history, so the later write did not build on exactly what the earlier task left).
 * The third does not: `apps/cli/test/cli.test.ts`, agent_6e6c8445 -> agent_c460874d, is a
 * *hash-verified clean handoff* -- zero intervening writes, later `beforeVersion` identical to
 * earlier `afterVersion` -- despite `contentionAmong` calling it contention on a 15.6-minute idle
 * gap. That is the corpus's own previously-flagged "widest gap any positive rests on" case. See
 * `outcome-cli-test-two-sessions` below for the full trail, and `docs/measurements/overlap-precision.md`
 * for what this does to the reported numbers. This is reported as a finding, not fixed here:
 * `packages/query/src/overlap.ts` is the detector under test and is out of scope for this pass.
 *
 * Five sequential pairs the old rule already called negative (no timing overlap) are also
 * hash-verified clean, which is the expected shape and the reason the gate is not zero for zero.
 */
export interface OverlapCorpusCase {
  readonly caseId: string;
  /** Why this label is right, so a reader can disagree with the label rather than guess at it. */
  readonly note: string;
  readonly expectedContention: boolean;
  readonly tasks: readonly OverlappingTask[];
  /** Observed activity per worker, keyed and grouped by the rule's own helpers. */
  readonly activityByWorker: ReadonlyMap<string, WorkerActivity>;
  /**
   * The independent evidence the label above was derived from: two real `file.changed` records
   * for the same resource, verified against the live ledger at commit `6240502`. Never null for
   * an entry in `overlapCorpus` -- a case with no independent evidence belongs in
   * `detectorBehaviorRegressionCases` instead.
   */
  readonly outcome: ContentHashOutcome;
}

/**
 * One verified content-hash comparison between two writes to the same resource.
 *
 * `chainMatches` is the whole signal: it says whether `laterBeforeHash` is literally the same
 * digest as `earlierAfterHash`. Nothing here says *why* a mismatch happened -- that is what
 * `intervening` is for, because a mismatch caused by the same agent's own next turn, or by an
 * unattributed observation nobody can attribute to a second worker, is not the same finding as a
 * mismatch caused by a distinct third party. Reporting the hashes without that context would let
 * "diverged" be misread as "clobbered."
 */
export interface ContentHashOutcome {
  readonly resourceLocator: string;
  readonly earlierTaskId: string;
  readonly earlierAfterHash: string;
  readonly laterTaskId: string;
  readonly laterBeforeHash: string;
  readonly chainMatches: boolean;
  /** What, if anything, is known to have touched the file between the two compared writes. */
  readonly intervening: string;
}

export const overlapCorpusVersion = "field-v3-hash-verified";

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
function active(
  entries: readonly (readonly [string, readonly string[]])[],
): ReadonlyMap<string, WorkerActivity> {
  return new Map(entries.map(([agentId, at]) => [workerKey(agentId, WT), [...at].sort()] as const));
}

/**
 * Observed activity for the agents below, verbatim from the ledger.
 *
 * These six agents account for roughly 3,000 events and a corpus nobody can read is a corpus
 * nobody checks, so this is a sample rather than all of them. What it samples is chosen by what
 * the rule asks: the boundaries of each stretch of continuous work at a 30-minute silence
 * threshold, **plus the real event nearest before every write any case below judges**.
 *
 * Shared across cases because it is a property of the session, not of the file.
 */
const OBSERVED_ACTIVITY = active([
  [A_B48C, [
    "2026-08-21T15:46:26.790Z", "2026-08-21T17:31:41.412Z",
    "2026-08-22T04:56:04.072Z", "2026-08-22T06:18:45.622Z",
    "2026-08-22T07:26:30.589Z", "2026-08-22T07:47:17.174Z",
  ]],
  [A_6222, [
    "2026-08-22T07:49:54.122Z", "2026-08-22T07:59:25.272Z",
    "2026-08-22T11:11:43.339Z", "2026-08-22T12:23:04.194Z",
    "2026-08-22T13:17:57.704Z", "2026-08-22T13:51:29.032Z",
    "2026-08-22T14:47:00.805Z", "2026-08-22T15:18:04.471Z",
  ]],
  [A_2478, [
    "2026-08-22T15:21:05.926Z", "2026-08-22T16:44:38.043Z",
    "2026-08-22T17:25:19.376Z",
    "2026-08-22T19:06:43.770Z", "2026-08-22T19:19:40.184Z",
    "2026-08-22T19:26:37.604Z",
  ]],
  [A_6E6C, [
    "2026-08-22T18:44:12.893Z", "2026-08-22T19:27:39.286Z",
    "2026-08-23T01:42:30.653Z",
    "2026-08-23T02:00:58.633Z",
    "2026-08-23T02:37:23.730Z", "2026-08-23T02:51:44.702Z",
  ]],
  [A_C460, ["2026-08-23T01:57:38.353Z", "2026-08-23T03:17:28.865Z"]],
  [A_0509, [
    "2026-08-23T03:13:48.818Z", "2026-08-23T03:15:50.765Z",
    "2026-08-23T05:17:34.470Z", "2026-08-23T06:47:56.026Z",
  ]],
]);

/**
 * The field corpus: only pairs with a verified content-hash comparison on both sides.
 *
 * n=8. Two agent pairs contribute the two hash-verified positives and one hash-verified false
 * positive; three agent pairs contribute the five hash-verified negatives. This is one
 * repository, one developer's session set, and eight cases -- read `docs/measurements/overlap-precision.md`
 * before citing a number out of this file.
 */
export const overlapCorpus: readonly OverlapCorpusCase[] = [
  // ---- Hash-verified divergence: the later write did not build on the compared task's output. ----
  {
    caseId: "outcome-readme-two-sessions",
    note:
      "agent_2478f630 wrote README.md at 16:21 (task_0bb449ec, afterVersion de4d5db5..). Before "
      + "agent_6e6c8445 wrote it again at 19:19 (task_84cff6b6, beforeVersion 5f4d8c5c..), three "
      + "more writes landed: agent_2478f630's own task_aa0c992a (17:49) and task_36f945ab "
      + "(18:28), then one unattributed write (18:47, no task, no agent). No second identified "
      + "worker intervened, but the later write plainly did not build on this task's exact "
      + "output -- the file was in active flux the whole time both sessions were open over it, "
      + "which is what the original note called this pair without a hash to check it against.",
    expectedContention: true,
    tasks: [
      task("task_0bb449ec-74ff-4d48-9b92-0d3c165632a3", A_2478, "2026-08-22T16:21:30.353Z"),
      task("task_84cff6b6-afe5-4505-922b-fc4b2e10c90e", A_6E6C, "2026-08-22T19:19:56.857Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
    outcome: {
      resourceLocator: "README.md",
      earlierTaskId: "task_0bb449ec-74ff-4d48-9b92-0d3c165632a3",
      earlierAfterHash: "de4d5db57d22aab324b4558adb3b2818fc09c668dfc18c618d3aecd5eb057e8f",
      laterTaskId: "task_84cff6b6-afe5-4505-922b-fc4b2e10c90e",
      laterBeforeHash: "5f4d8c5cdb2d0e2ecf75339ea35d4a927f84f8abaf49955e605849894f6c64ae",
      chainMatches: false,
      intervening:
        "agent_2478f630's task_aa0c992a (17:49) and task_36f945ab (18:28), then one "
        + "unattributed write (18:47) -- no second identified agent.",
    },
  },
  {
    caseId: "outcome-effects-two-sessions",
    note:
      "agent_2478f630 wrote packages/recorder/src/effects.ts at 18:28 (task_36f945ab, corrected "
      + "from the field-v2 corpus's task_aa0c992a, which the ledger shows really wrote at 17:49 "
      + "to a different file -- that pairing was a labeling error, not a real event). Before "
      + "agent_6e6c8445 wrote it again at 19:07 (task_84cff6b6), one unattributed write landed "
      + "(18:47). The independently recorded genuine two-agent contention still checks out: the "
      + "later write did not build on this task's exact output.",
    expectedContention: true,
    tasks: [
      task("task_36f945ab-de20-48e7-9abd-c6aa3269c4ad", A_2478, "2026-08-22T18:28:15.880Z"),
      task("task_84cff6b6-afe5-4505-922b-fc4b2e10c90e", A_6E6C, "2026-08-22T19:07:07.173Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
    outcome: {
      resourceLocator: "packages/recorder/src/effects.ts",
      earlierTaskId: "task_36f945ab-de20-48e7-9abd-c6aa3269c4ad",
      earlierAfterHash: "8877c56e01bf0f1a5413983132fa7e1c3aa5e0744a74cbedf8f143c1ede63741",
      laterTaskId: "task_84cff6b6-afe5-4505-922b-fc4b2e10c90e",
      laterBeforeHash: "d7f59047e1e925dcc5eaa16b7025a5d562fd4ea3a4be494687b4bc9d7ad2603c",
      chainMatches: false,
      intervening: "One unattributed write (18:47) -- no second identified agent.",
    },
  },

  // ---- Hash-verified clean handoff, despite the detector calling it contention. ----
  {
    caseId: "outcome-cli-test-two-sessions",
    note:
      "agent_6e6c8445 wrote apps/cli/test/cli.test.ts at 01:50 (task_bdcd6537, afterVersion "
      + "9ee968d4..). agent_c460874d wrote it at 02:16 (task_da4a5484, beforeVersion 9ee968d4.. "
      + "-- the SAME digest). Zero writes intervened. This is the field-v1/field-v2 corpus's "
      + "'widest gap any positive rests on' pair (15.6 minutes), and content hashes prove it was "
      + "a clean, directly-adjacent handoff: agent_c460874d built on exactly what agent_6e6c8445 "
      + "left. `contentionAmong` calls this contention because the gap sits under "
      + "IDLE_GAP_MINUTES=30. Independent evidence disagrees. This is the corpus's one measured "
      + "disagreement between the timing heuristic and the outcome, and it is reported here as a "
      + "finding rather than fixed -- packages/query/src/overlap.ts is the detector under test.",
    expectedContention: false,
    tasks: [
      task("task_bdcd6537-faff-498c-a44e-fee221d48343", A_6E6C, "2026-08-23T01:50:03.801Z"),
      task("task_da4a5484-8850-42e6-b8d0-03f6e8f6aed4", A_C460, "2026-08-23T02:16:37.618Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
    outcome: {
      resourceLocator: "apps/cli/test/cli.test.ts",
      earlierTaskId: "task_bdcd6537-faff-498c-a44e-fee221d48343",
      earlierAfterHash: "9ee968d4326865e18da102f2b6a97b9ec1edee8344e29566b4c46e8c10e3fd75",
      laterTaskId: "task_da4a5484-8850-42e6-b8d0-03f6e8f6aed4",
      laterBeforeHash: "9ee968d4326865e18da102f2b6a97b9ec1edee8344e29566b4c46e8c10e3fd75",
      chainMatches: true,
      intervening: "None -- directly adjacent in the file's real history.",
    },
  },

  // ---- Hash-verified clean handoffs, agreeing with the detector's negative call. ----
  {
    caseId: "outcome-effects-sequence-b48c-6222",
    note:
      "agent_b48c1c15 wrote packages/recorder/src/effects.ts at 05:57 (task_628b6926); "
      + "agent_62225cb8 wrote it at 11:52 (task_efccb533) with a beforeVersion identical to "
      + "b48c1c15's afterVersion. Clean, directly-adjacent handoff, no timing overlap either.",
    expectedContention: false,
    tasks: [
      task("task_628b6926-0cc6-4e36-9eb7-9061d1918afe", A_B48C, "2026-08-22T05:57:11.643Z"),
      task("task_efccb533-4c3b-42a2-9cd6-513c21d4cb9a", A_6222, "2026-08-22T11:52:59.178Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
    outcome: {
      resourceLocator: "packages/recorder/src/effects.ts",
      earlierTaskId: "task_628b6926-0cc6-4e36-9eb7-9061d1918afe",
      earlierAfterHash: "397e6f42f3c545ecc483370d6733826906767702d26328a51b2fd36ad6fe10b3",
      laterTaskId: "task_efccb533-4c3b-42a2-9cd6-513c21d4cb9a",
      laterBeforeHash: "397e6f42f3c545ecc483370d6733826906767702d26328a51b2fd36ad6fe10b3",
      chainMatches: true,
      intervening: "None -- directly adjacent in the file's real history.",
    },
  },
  {
    caseId: "outcome-gateway-index-sequence-b48c-6222",
    note:
      "agent_b48c1c15 wrote packages/gateway/src/index.ts at 07:46 (task_771fe0be); "
      + "agent_62225cb8 wrote it at 13:51 (task_7cddd7e8) with a matching beforeVersion. Clean "
      + "handoff, one of four sessions that each touched this file in sequence.",
    expectedContention: false,
    tasks: [
      task("task_771fe0be-cb26-4b44-a1e5-caa8bff7cffd", A_B48C, "2026-08-22T07:46:13.891Z"),
      task("task_7cddd7e8-e5cc-416c-a082-3ffbcce09605", A_6222, "2026-08-22T13:51:29.032Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
    outcome: {
      resourceLocator: "packages/gateway/src/index.ts",
      earlierTaskId: "task_771fe0be-cb26-4b44-a1e5-caa8bff7cffd",
      earlierAfterHash: "9fc2ac78e07a4c3bee110cf603fe8e29651ca2a668a096b636a65b22cfccfabd",
      laterTaskId: "task_7cddd7e8-e5cc-416c-a082-3ffbcce09605",
      laterBeforeHash: "9fc2ac78e07a4c3bee110cf603fe8e29651ca2a668a096b636a65b22cfccfabd",
      chainMatches: true,
      intervening: "None -- directly adjacent in the file's real history.",
    },
  },
  {
    caseId: "outcome-gateway-index-sequence-6222-2478",
    note:
      "agent_62225cb8 wrote packages/gateway/src/index.ts at 13:51 (task_7cddd7e8); "
      + "agent_2478f630 wrote it at 18:28 (task_36f945ab) with a matching beforeVersion. Clean "
      + "handoff between the second and third of the four sequential sessions on this file.",
    expectedContention: false,
    tasks: [
      task("task_7cddd7e8-e5cc-416c-a082-3ffbcce09605", A_6222, "2026-08-22T13:51:29.032Z"),
      task("task_36f945ab-de20-48e7-9abd-c6aa3269c4ad", A_2478, "2026-08-22T18:28:15.880Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
    outcome: {
      resourceLocator: "packages/gateway/src/index.ts",
      earlierTaskId: "task_7cddd7e8-e5cc-416c-a082-3ffbcce09605",
      earlierAfterHash: "ce6d9d52bd90419fd37b6f81552749f183eeb11b97abd8af667320af5e7900bd",
      laterTaskId: "task_36f945ab-de20-48e7-9abd-c6aa3269c4ad",
      laterBeforeHash: "ce6d9d52bd90419fd37b6f81552749f183eeb11b97abd8af667320af5e7900bd",
      chainMatches: true,
      intervening: "None -- directly adjacent in the file's real history.",
    },
  },
  {
    caseId: "outcome-gateway-recap-sequence-b48c-6222",
    note:
      "agent_b48c1c15 created packages/gateway/src/recap.ts at 07:46 (task_771fe0be); "
      + "agent_62225cb8 wrote it at 11:52 (task_efccb533) with a matching beforeVersion. Clean "
      + "handoff at the start of a file five sessions each touched in turn.",
    expectedContention: false,
    tasks: [
      task("task_771fe0be-cb26-4b44-a1e5-caa8bff7cffd", A_B48C, "2026-08-22T07:46:13.891Z"),
      task("task_efccb533-4c3b-42a2-9cd6-513c21d4cb9a", A_6222, "2026-08-22T11:52:59.178Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
    outcome: {
      resourceLocator: "packages/gateway/src/recap.ts",
      earlierTaskId: "task_771fe0be-cb26-4b44-a1e5-caa8bff7cffd",
      earlierAfterHash: "d302a2b17dd6cf69c527980e23d43d0a124cdd0abaaf8bc2ff5a99c2d68ffc3a",
      laterTaskId: "task_efccb533-4c3b-42a2-9cd6-513c21d4cb9a",
      laterBeforeHash: "d302a2b17dd6cf69c527980e23d43d0a124cdd0abaaf8bc2ff5a99c2d68ffc3a",
      chainMatches: true,
      intervening: "None -- directly adjacent in the file's real history.",
    },
  },
  {
    caseId: "outcome-gateway-recap-sequence-6222-2478",
    note:
      "agent_62225cb8 wrote packages/gateway/src/recap.ts at 15:08 (task_26793dd8); "
      + "agent_2478f630 wrote it at 16:21 (task_0bb449ec) with a matching beforeVersion. Clean "
      + "handoff, no timing overlap: agent_62225cb8's last observed activity (15:18) precedes "
      + "the later write by over an hour.",
    expectedContention: false,
    tasks: [
      task("task_26793dd8-8467-4b78-a8d9-b956273f493c", A_6222, "2026-08-22T15:08:24.677Z"),
      task("task_0bb449ec-74ff-4d48-9b92-0d3c165632a3", A_2478, "2026-08-22T16:21:30.353Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
    outcome: {
      resourceLocator: "packages/gateway/src/recap.ts",
      earlierTaskId: "task_26793dd8-8467-4b78-a8d9-b956273f493c",
      earlierAfterHash: "57a5a7d15f492a6a7f29c47e693ac0870f2cb4a30cb6b585b6e7366a8c1d5612",
      laterTaskId: "task_0bb449ec-74ff-4d48-9b92-0d3c165632a3",
      laterBeforeHash: "57a5a7d15f492a6a7f29c47e693ac0870f2cb4a30cb6b585b6e7366a8c1d5612",
      chainMatches: true,
      intervening: "None -- directly adjacent in the file's real history.",
    },
  },
];

/**
 * Cases with no independent hash evidence: they describe what `contentionAmong` is *specified*
 * to do at a boundary, not a measurement of whether that specification is right on real data.
 *
 * `field-v2` folded these into the same array as its field cases, which is part of what made a
 * nine-case corpus look like nine pieces of field evidence when four of them were structural or
 * constructed. Kept here because they are still real regression value -- losing them would let
 * `contentionAmong` silently regress on shapes it was explicitly built to handle -- but they do
 * not feed `evaluateOverlapQuality`'s precision/recall gate, and citing their pass rate as field
 * validity would repeat the mistake this file exists to fix.
 */
export interface DetectorBehaviorCase {
  readonly caseId: string;
  readonly note: string;
  readonly expectedContention: boolean;
  readonly tasks: readonly OverlappingTask[];
  readonly activityByWorker: ReadonlyMap<string, WorkerActivity>;
}

export const detectorBehaviorRegressionCases: readonly DetectorBehaviorCase[] = [
  {
    caseId: "structural-one-worker-consecutive-turns",
    note:
      "One session's own two turns. A session runs one task at a time, so this is sequence by "
      + "construction, independent of any timing threshold or content hash. This exact shape "
      + "was eight out of eight false positives once already.",
    expectedContention: false,
    tasks: [
      task("task_own_a", A_6E6C, "2026-08-23T01:50:03.801Z"),
      task("task_own_b", A_6E6C, "2026-08-23T02:39:55.253Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
  },
  {
    caseId: "structural-unattributed-second-writer",
    note:
      "A change with no agent and no worktree could belong to either party, so counting it as a "
      + "second participant would invent the very thing being reported. Structural, by "
      + "`hasDistinctWorkers`'s own definition -- not a timing or content question.",
    expectedContention: false,
    tasks: [
      task("task_attributed", A_2478, "2026-08-22T16:21:30.353Z"),
      task("task_unattributed", null, "2026-08-22T18:00:00.000Z", null),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
  },
  {
    caseId: "boundary-idle-session-spanning-a-later-write",
    note:
      "Constructed to probe the shape `field-v1`'s session-span rule got wrong: a session that "
      + "has not ended is not a worker at the keyboard. There is no real second `file.changed` "
      + "at this exact instant for agent_62225cb8 to hash-check against -- this pins "
      + "`contentionAmong`'s specified behavior at the idle-gap boundary, not a field outcome.",
    expectedContention: false,
    tasks: [
      task("task_idle_earlier", A_2478, "2026-08-22T15:21:05.926Z"),
      task("task_idle_later", A_6222, "2026-08-22T16:21:30.353Z"),
    ],
    activityByWorker: active([
      [A_2478, ["2026-08-22T15:21:05.926Z", "2026-08-22T19:26:37.604Z"]],
      [A_6222, ["2026-08-22T15:18:04.471Z"]],
    ]),
  },
  {
    caseId: "boundary-long-session-that-never-came-back",
    note:
      "agent_b48c1c15's activity here spans 67.8 hours in the ledger. A worker whose last act "
      + "precedes the other write has finished, however long its session looks. Constructed to "
      + "pin that specification; the two timestamps are real activity boundaries but not a real "
      + "shared-file write pair, so there is nothing to hash-check.",
    expectedContention: false,
    tasks: [
      task("task_long_earlier", A_B48C, "2026-08-21T15:46:26.790Z"),
      task("task_long_later", A_0509, "2026-08-23T05:17:34.470Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
  },
  {
    caseId: "boundary-finished-exactly-at-the-later-write",
    note:
      "The earlier worker's last activity is the same instant as the later write. Treated as "
      + "finished, not as contending: an inclusive boundary would make every hand-off where one "
      + "session ends as another begins into a collision. Pins the exclusive-boundary code path; "
      + "no real second write exists at this exact instant to hash-check.",
    expectedContention: false,
    tasks: [
      task("task_boundary_a", A_B48C, "2026-08-22T05:57:11.643Z"),
      task("task_boundary_b", A_6222, "2026-08-22T07:47:17.174Z"),
    ],
    activityByWorker: OBSERVED_ACTIVITY,
  },
];
