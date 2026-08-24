/**
 * Ground-truth scenario definitions for the concurrency-manufacturing harness.
 *
 * This file is pure data plus types: no filesystem access, no clock, no recorder imports.
 * `harness.ts` is what turns these into real journal entries, real file writes, and a real
 * ingest/effects drain. Keeping the two separate means the scenario a case describes and the
 * mechanics that replay it can be read (and reasoned about) independently.
 *
 * Every case gets its own file and its own pair of session ids, so cases never interact through
 * the shared scratch checkout or the shared ledger -- the only thing that ties them together is
 * that they are replayed against one worktree, which is what makes this an end-to-end exercise
 * of the recorder rather than thirteen isolated unit tests.
 */

export type CaseKind =
  | "positive-interleaved"
  | "negative-large-gap-and-stopped"
  | "negative-small-gap-but-stopped"
  | "boundary-probe";

export interface CaseWorker {
  /** Label used only inside this file's actions ("A" / "B"), not a recorded identifier. */
  readonly label: string;
  /** The host session id fed into the recorder. `agentIdForSession` derives the real agent id
   *  from this, so it is what `findOverlappingWork` actually keys distinct workers on. */
  readonly sessionId: string;
}

export interface CaseAction {
  readonly worker: string;
  /** Minutes from this case's own t=0. Never wall-clock, never real elapsed time -- see
   *  `isoAt` in harness.ts for how this becomes a controlled timestamp. */
  readonly offsetMinutes: number;
  /** A write is a real `fs.writeFileSync` plus a recorded Write call. A read is a recorded
   *  Read call only -- it establishes the worker was active without changing the file. */
  readonly kind: "write" | "read";
}

export interface HarnessCase {
  readonly caseId: string;
  readonly kind: CaseKind;
  readonly description: string;
  /** Repo-relative path, POSIX separators, unique across every case. */
  readonly file: string;
  readonly workers: readonly CaseWorker[];
  readonly actions: readonly CaseAction[];
  /**
   * Ground truth asserted from how the case was *built* -- which workers were actually active
   * when -- never by re-running the detector's own idle-gap/still-going formula. Doing the
   * latter is the exact circularity found in `tools/phase2/overlap-corpus.ts` (the corpus
   * labelled cases using `contentionAmong`'s own rule, so 1.0 precision measured conformance,
   * not validity). Boundary probes deliberately carry no verdict for the same reason: whether a
   * given idle gap should count as "still working" is the open question the sweep exists to
   * inform, not something this file gets to assume.
   */
  readonly groundTruth: "contended" | "sequential" | "undetermined";
  /**
   * Only set on boundary probes: minutes between the earlier worker's last observed activity
   * before the later write and the later write itself. This is the one variable the probe
   * holds up against `IDLE_GAP_MINUTES` (30); everything else about the probe is fixed.
   */
  readonly constructedGapMinutes?: number;
}

const BOUNDARY_ANCHOR_MINUTES = 100;
const BOUNDARY_GAPS_MINUTES = [5, 15, 25, 29, 30, 31, 35, 45, 90] as const;

function boundaryProbe(gapMinutes: number): HarnessCase {
  const a: CaseWorker = { label: "A", sessionId: `harness-boundary-${gapMinutes}m-agent-a` };
  const b: CaseWorker = { label: "B", sessionId: `harness-boundary-${gapMinutes}m-agent-b` };
  return {
    caseId: `boundary-${gapMinutes}m`,
    kind: "boundary-probe",
    file: `docs/boundary-${gapMinutes}m.md`,
    workers: [a, b],
    actions: [
      { worker: "A", offsetMinutes: 0, kind: "write" },
      { worker: "A", offsetMinutes: BOUNDARY_ANCHOR_MINUTES - gapMinutes, kind: "read" },
      { worker: "B", offsetMinutes: BOUNDARY_ANCHOR_MINUTES, kind: "write" },
      { worker: "A", offsetMinutes: BOUNDARY_ANCHOR_MINUTES + 2, kind: "read" },
    ],
    groundTruth: "undetermined",
    constructedGapMinutes: gapMinutes,
    description:
      `Agent A writes the file, then is observed ${gapMinutes} minute(s) later doing something ` +
      `else (a read), then agent B writes the same file, then A is observed again 2 minutes after ` +
      `that. "Still going afterward" holds by construction in every probe; only the pre-write idle ` +
      `gap (${gapMinutes} min) varies. This is where IDLE_GAP_MINUTES (30) should flip the verdict.`,
  };
}

export function buildCases(): readonly HarnessCase[] {
  const cases: HarnessCase[] = [
    {
      caseId: "positive-tight-interleave",
      kind: "positive-interleaved",
      file: "notes/shared-plan.md",
      workers: [
        { label: "A", sessionId: "harness-p1-agent-a" },
        { label: "B", sessionId: "harness-p1-agent-b" },
      ],
      actions: [
        { worker: "A", offsetMinutes: 0, kind: "write" },
        { worker: "B", offsetMinutes: 3, kind: "write" },
        { worker: "A", offsetMinutes: 6, kind: "write" },
        { worker: "B", offsetMinutes: 9, kind: "read" },
        { worker: "A", offsetMinutes: 12, kind: "write" },
      ],
      groundTruth: "contended",
      description:
        "Two agents alternate edits to one file across a 12-minute window, each still active " +
        "around the other's writes -- the tightest, least ambiguous shape of real concurrent work.",
    },
    {
      caseId: "positive-background-owner",
      kind: "positive-interleaved",
      file: "config/settings.json",
      workers: [
        { label: "A", sessionId: "harness-p2-agent-a" },
        { label: "B", sessionId: "harness-p2-agent-b" },
      ],
      actions: [
        { worker: "A", offsetMinutes: 0, kind: "write" },
        { worker: "A", offsetMinutes: 5, kind: "read" },
        { worker: "B", offsetMinutes: 8, kind: "write" },
        { worker: "A", offsetMinutes: 10, kind: "read" },
        { worker: "A", offsetMinutes: 15, kind: "read" },
        { worker: "A", offsetMinutes: 20, kind: "read" },
      ],
      groundTruth: "contended",
      description:
        "Agent A owns a file and keeps working nearby (reads at 5/10/15/20 min); agent B lands " +
        "one edit at minute 8, squarely inside A's ongoing activity -- the shape the live " +
        "ledger's genuine contention cases actually had.",
    },
    {
      caseId: "negative-cold-handoff",
      kind: "negative-large-gap-and-stopped",
      file: "docs/handoff-cold.md",
      workers: [
        { label: "A", sessionId: "harness-n1-agent-a" },
        { label: "B", sessionId: "harness-n1-agent-b" },
      ],
      actions: [
        { worker: "A", offsetMinutes: 0, kind: "write" },
        { worker: "A", offsetMinutes: 2, kind: "read" },
        { worker: "A", offsetMinutes: 4, kind: "read" },
        { worker: "B", offsetMinutes: 180, kind: "write" },
      ],
      groundTruth: "sequential",
      description:
        "Agent A finishes and goes quiet at minute 4; agent B does not touch the file until " +
        "three hours later. Both halves of the rule fail -- the idle gap is huge and A never " +
        "resumed -- so this is an unambiguous hand-off, not contention.",
    },
    {
      caseId: "negative-warm-handoff",
      kind: "negative-small-gap-but-stopped",
      file: "docs/handoff-warm.md",
      workers: [
        { label: "A", sessionId: "harness-n2-agent-a" },
        { label: "B", sessionId: "harness-n2-agent-b" },
      ],
      actions: [
        { worker: "A", offsetMinutes: 0, kind: "write" },
        { worker: "A", offsetMinutes: 3, kind: "read" },
        { worker: "B", offsetMinutes: 8, kind: "write" },
      ],
      groundTruth: "sequential",
      description:
        "Agent A's last action is 5 minutes before agent B's write -- comfortably inside the " +
        "30-minute idle-gap allowance -- but A never acts again. This isolates the " +
        "'still going afterward' half of the rule from the idle-gap half: a small gap alone " +
        "must not be enough to call this contention. A corpus built only from gap size could " +
        "not produce this case, which is exactly why it is a false-positive risk worth measuring.",
    },
  ];
  for (const gap of BOUNDARY_GAPS_MINUTES) cases.push(boundaryProbe(gap));
  return cases;
}
