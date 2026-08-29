import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  diffSnapshots,
  fileResourceId,
  NodeObservationBoundary,
  normalizeLogicalPath,
  type ObservationCapture,
  type ObservationContext,
  type ObservationSnapshot,
  type ObservedFileChange,
  type ObservedFileState,
} from "patchmesh-observation";
import {
  connectObservationSidecar,
  deterministicObservationDrainId,
  type ObservationDrainResult,
} from "patchmesh-observation";
import type { AgentId, CorrelationId, EventId, ProtocolEvent, Source, TaskId } from "patchmesh-protocol";
import { createCorrelationId, createEventId, deterministicUuid, type RepositoryIdentity } from "./identity.js";
import { LEDGER_DIRECTORY } from "./record.js";

/**
 * What actually changed on disk, attributed to the turn that changed it.
 *
 * The recorder knows a tool was called; it did not know a file was written, because the only
 * path it has comes from a `file_path` argument and 90% of real calls are shell commands that
 * have none. Observing the filesystem closes that gap without parsing intent out of a command,
 * which is the inference the evidence design rules out.
 *
 * Observation runs per turn, not per call, and that is a deliberate ceiling rather than a
 * first step. Per-call capture was measured against the hook's 108ms budget and does not fit:
 * `git status --porcelain` costs 281-384ms and a bare mtime walk 141-219ms, so scanning on the
 * tool-call path would cost more than the recording it serves. The alternative - a long-lived
 * watcher joined to calls by timestamp - buys per-call precision that is correlation anyway,
 * since a change is attributed to whichever call's window contains it. A turn is a real
 * boundary the host declares, so attributing to it asserts only what was observed: these files
 * differ, and this task was the work in flight while they changed.
 */

const SNAPSHOT_VERSION = 1;

/**
 * The recorder's own state lives inside the worktree it observes, so every capture sees the
 * snapshot and ledger it just wrote and reports them as the agent's work. Filtering here
 * rather than in `isIgnoredObservationPath` keeps the shared policy alone: its version is
 * bound into the M0 workload contract, and this is the recorder's private business.
 */
const RECORDER_STATE_PREFIX = `${LEDGER_DIRECTORY}/`;

function isRecorderState(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized === LEDGER_DIRECTORY || normalized.startsWith(RECORDER_STATE_PREFIX);
}

export interface StoredSnapshot {
  readonly v: number;
  readonly at: string;
  readonly repository: ObservationSnapshot["repository"];
  readonly worktree: ObservationSnapshot["worktree"];
  readonly files: readonly (readonly [string, ObservedFileState])[];
}

export function readSnapshot(snapshotPath: string): ObservationSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as StoredSnapshot;
    if (parsed.v !== SNAPSHOT_VERSION || !Array.isArray(parsed.files)) return null;
    return {
      repository: parsed.repository,
      worktree: parsed.worktree,
      files: new Map(parsed.files.map(([path, state]) => [path, state])),
    };
  } catch {
    // No snapshot, or one this build cannot read. Either way the next capture becomes the
    // new baseline; a missing baseline must never be treated as "the repository was empty",
    // which would report every file in the checkout as created.
    return null;
  }
}

export function writeSnapshot(snapshotPath: string, snapshot: ObservationSnapshot, at: string): void {
  const stored: StoredSnapshot = {
    v: SNAPSHOT_VERSION,
    at,
    repository: snapshot.repository,
    worktree: snapshot.worktree,
    files: [...snapshot.files.entries()],
  };
  mkdirSync(dirname(snapshotPath), { recursive: true });
  // Written aside and renamed into place, because the snapshot now has more than one writer.
  // Draining on the read path means a report and the Stop hook can capture at the same moment,
  // and a torn snapshot does not fail loudly - `readSnapshot` treats an unparseable file as no
  // baseline at all, which reports every file in the checkout as newly created. Rename is
  // atomic, so a concurrent reader sees either the old snapshot or the new one.
  const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(stored), "utf8");
    renameSync(temporaryPath, snapshotPath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Nothing further to do: the temporary is inert, and the real failure is the one below.
    }
    throw error;
  }
}

/**
 * Which of these paths the repository already declares are not work product.
 *
 * Observation ignores only `.git` and `node_modules`, so it reports build output and other
 * tools' caches as agent work. Measured on this repository: of 24 observed changes, 18 were a
 * sibling tool's cache and 3 were build output, leaving 2 that were source. A tool meant to
 * warn about contested files would mostly have warned about cache churn.
 *
 * `.gitignore` is the answer already written down, so this asks git rather than inventing a
 * heuristic to tune. One batched `check-ignore` covers the whole change set - a small list,
 * and this runs at ingest where a subprocess is affordable; see
 * `effect-detection-cannot-run-on-the-hook-hot-path` for why nothing here may move per-call.
 *
 * Tracked files are never reported as ignored even when a rule would match them, which is
 * git's own rule and the one we want: a file the repository keeps is work product.
 *
 * Fails open. If git is missing, or this is not a repository, every change is kept: recording
 * noise is a cost, and silently dropping real work is a lie.
 *
 * Exported because the read side needs the same answer. A ledger is append-only, so filtering
 * only at write time leaves every change recorded before this existed replaying forever - which
 * is exactly what it did: the first live `patchmesh_overlapping_work` call after this landed
 * still returned eight files, all of them a sibling tool's cache.
 */
export function ignoredByRepository(worktreeRoot: string, paths: readonly string[]): ReadonlySet<string> {
  if (paths.length === 0) return new Set();
  const remembered = rememberedIgnoreDecisions(worktreeRoot);
  const unknown = paths.filter((path) => !remembered.has(path));
  if (unknown.length === 0) {
    return new Set(paths.filter((path) => remembered.get(path) === true));
  }
  const asked = askGitWhichAreIgnored(worktreeRoot, unknown);
  for (const path of unknown) remembered.set(path, asked.has(path));
  return new Set(paths.filter((path) => remembered.get(path) === true));
}

/**
 * What this worktree has already been asked about, keyed by the rules in force when it answered.
 *
 * `git check-ignore` is a subprocess: measured at **285ms** on Windows, paid once per answer.
 * That was tolerable at ingest, which is where this was written to run, but the read side calls
 * it too -- and once the read path stopped re-validating events and started caching windows, a
 * warm `overlaps` answer was mostly this one subprocess.
 *
 * The key is the mtime of the ignore files a repository-root query actually consults, so
 * editing `.gitignore` invalidates the memo rather than being papered over by it. It is not
 * exhaustive: a nested `.gitignore` deeper in the tree can change an answer without moving
 * either mtime. That is acceptable for an advisory read and for a process that lives no longer
 * than a session, and it is why this memoizes per process rather than persisting anything.
 */
const ignoreDecisions = new Map<string, Map<string, boolean>>();

function ignoreRulesFingerprint(worktreeRoot: string): string {
  const parts: string[] = [];
  for (const candidate of [join(worktreeRoot, ".gitignore"), join(worktreeRoot, ".git", "info", "exclude")]) {
    try {
      parts.push(String(statSync(candidate).mtimeMs));
    } catch {
      parts.push("absent");
    }
  }
  return parts.join(":");
}

function rememberedIgnoreDecisions(worktreeRoot: string): Map<string, boolean> {
  const key = `${worktreeRoot}\0${ignoreRulesFingerprint(worktreeRoot)}`;
  let decisions = ignoreDecisions.get(key);
  if (decisions === undefined) {
    // The rules moved, so every previous answer for this worktree is suspect. Dropping the
    // whole map is right: these are cheap to re-derive and wrong answers are not.
    ignoreDecisions.clear();
    decisions = new Map();
    ignoreDecisions.set(key, decisions);
  }
  return decisions;
}

function askGitWhichAreIgnored(worktreeRoot: string, paths: readonly string[]): ReadonlySet<string> {
  try {
    const output = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: worktreeRoot,
      input: paths.join("\0") + "\0",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return new Set(output.split("\0").filter((line) => line !== ""));
  } catch (error) {
    // Exit 1 means "none of them are ignored", which is an answer, not a failure. Anything
    // else - no git, no repository - leaves the set empty and keeps every change.
    const status = (error as { status?: unknown }).status;
    if (status === 1) return new Set();
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout !== "") {
      return new Set(stdout.split("\0").filter((line) => line !== ""));
    }
    return new Set();
  }
}

/**
 * One recorded call, and the window it occupied, as a candidate owner of an observed change.
 *
 * `startedAtMs` comes from the call's `PreToolUse` entry. Without that hook there is no window
 * -- start collapses onto completion -- and nothing binds, which is the correct degradation
 * rather than a guess.
 */
export interface EffectAttributionCall {
  readonly completionEventId: EventId;
  readonly correlationId: CorrelationId;
  readonly agentId: AgentId | null;
  readonly taskId: TaskId | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  /**
   * Logical path the call's own input declared, normalized the same way a change's path is,
   * or null for a call that names no path (Bash et al.). A declaration is evidence the host
   * handed us directly, so where it answers, the mtime join does not have to.
   */
  readonly declaredPath: string | null;
}

/**
 * When was this file last written, as the filesystem records it.
 *
 * This is what makes a change joinable to a call at all. The snapshot diff says *that* a file
 * differs, never *when* it came to differ, so without an mtime every change in a turn is
 * simultaneous and only the turn can own it. Only changed files are stat'ed -- a handful per
 * drain, off the hook path -- so this does not reintroduce the walk that
 * `effect-detection-cannot-run-on-the-hook-hot-path` rules out.
 *
 * A deleted file has nothing left to stat and therefore never binds.
 */
function changeTimeMs(worktreeRoot: string, change: ObservedFileChange): number | null {
  if (change.after === null) return null;
  try {
    // Floored to whole milliseconds: mtime carries sub-millisecond precision while journal
    // timestamps are integer ms, and comparing the two directly loses a write at the boundary.
    return Math.floor(statSync(join(worktreeRoot, change.path)).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * The one call whose execution window contains this change, or nothing.
 *
 * Sole containment is the whole rule. Two calls covering the same instant -- a subagent inside
 * its parent's span, two sessions in one repository -- make the owner unknowable, and picking
 * the shorter or the later one would be inference dressed as evidence. Ambiguity returns null
 * and the change stays attributed to the turn, which is what it was before this existed.
 *
 * This is correlation in time, not proof: a call that ran while a file changed is the best
 * available claim, not a demonstration that it did the writing. It is recorded as causation
 * because that is the strongest thing the recorded stream can say, and because the alternative
 * -- null -- asserts less than was actually observed.
 *
 * The last writer wins by construction: one mtime survives per file, so a file written by two
 * calls in one turn binds to the later of them and the earlier leaves no trace.
 */
function soleCallCovering(
  worktreeRoot: string,
  change: ObservedFileChange,
  calls: readonly EffectAttributionCall[],
): EffectAttributionCall | null {
  const at = changeTimeMs(worktreeRoot, change);
  if (at === null) return null;
  let found: EffectAttributionCall | null = null;
  for (const call of calls) {
    if (at < call.startedAtMs || at > call.completedAtMs) continue;
    if (found !== null) return null;
    found = call;
  }
  return found;
}

function isDescendant(childId: string, parentId: string): boolean {
  return childId.startsWith(`${parentId}.`);
}

/**
 * Like `soleCallCovering`, but when multiple calls cover the same mtime, prefers the child
 * over its parent. A child's agent id is `parent.sub.<id>`, so the parent/child relationship
 * is structural rather than declared. When the covering calls are unrelated, ambiguity still
 * returns null.
 */
function nestedCallCovering(
  worktreeRoot: string,
  change: ObservedFileChange,
  calls: readonly EffectAttributionCall[],
): EffectAttributionCall | null {
  const at = changeTimeMs(worktreeRoot, change);
  if (at === null) return null;
  const covering = calls.filter(
    (call) => at >= call.startedAtMs && at <= call.completedAtMs,
  );
  if (covering.length === 0) return null;
  if (covering.length === 1) return covering[0]!;
  // Multiple calls cover this mtime. Prefer a child over its parent.
  for (const candidate of covering) {
    if (candidate.agentId === null) continue;
    const isChild = covering.some(
      (other) =>
        other !== candidate &&
        other.agentId !== null &&
        isDescendant(candidate.agentId, other.agentId),
    );
    if (isChild) return candidate;
  }
  return null;
}

/**
 * Bind one observed change to the call that owns it, or to nothing.
 *
 * The declared path is tried first. Edit- and Write-shaped calls name their target in
 * `tool_input`, and that naming is a fact the host asserted, not a pattern inferred -- so when
 * exactly one call in the drain declared the changed path, it owns the change even where the
 * mtime join is silent (overlapping windows) or unanswerable (a deleted file has no mtime).
 * Zero or several declarers say nothing: several would be a guess between them, so the sole-
 * window rule decides exactly as before.
 *
 * Exported because these three rules are the honesty contract for attribution and are pinned
 * by tests directly; everything downstream only inherits their verdicts.
 */
export function bindChange(
  worktreeRoot: string,
  change: ObservedFileChange,
  calls: readonly EffectAttributionCall[],
): EffectAttributionCall | null {
  const declaring = calls.filter((call) => call.declaredPath !== null && call.declaredPath === change.path);
  if (declaring.length === 1) return declaring[0]!;
  return nestedCallCovering(worktreeRoot, change, calls);
}

export interface ObserveTurnEffectsOptions {
  readonly identity: RepositoryIdentity;
  readonly snapshotPath: string;
  readonly source: Source;
  /** The turn whose work is being closed, or null when the drain could not name exactly one. */
  readonly agentId: AgentId | null;
  readonly taskId: TaskId | null;
  readonly now?: () => string;
  readonly nextEventId?: () => EventId;
  /** Calls drained in this same round, against whose windows changes are matched. */
  readonly calls?: readonly EffectAttributionCall[] | undefined;
  /** Stable id for the persistent sidecar transaction. */
  readonly requestId?: string | undefined;
}

export interface TurnEffects {
  readonly events: readonly ProtocolEvent[];
  /** Set when the baseline was missing, so this run only established one. */
  readonly baselineOnly: boolean;
  /** Acknowledge the sidecar only after ledger append succeeds. */
  readonly acknowledge?: (() => Promise<void>) | undefined;
}

function stableId(prefix: string, namespace: string, value: string): string {
  return `${prefix}${deterministicUuid(namespace, value).replaceAll("-", "")}`;
}

export function observationRequestId(options: Pick<ObserveTurnEffectsOptions, "identity" | "agentId" | "taskId" | "calls">): string {
  const calls = [...(options.calls ?? [])].map((call) => call.completionEventId).sort().join(",");
  const turn = `${options.agentId ?? ""}\0${options.taskId ?? ""}`;
  return deterministicObservationDrainId({
    workspaceRoot: options.identity.worktreeRoot,
    repositoryId: options.identity.repositoryId,
    workspaceId: options.identity.workspaceId,
    worktreeId: options.identity.worktreeId,
  }, `${turn}\0${calls}`);
}

/**
 * Capture the worktree, emit a `file.changed` for every difference from the stored baseline,
 * and leave the new capture as the next baseline.
 *
 * The first run of a checkout emits nothing. Without a baseline the diff would report every
 * tracked file as created and attribute the entire repository to one turn, which is worse
 * than silence: a wrong answer that looks like evidence.
 */
export async function observeTurnEffects(options: ObserveTurnEffectsOptions): Promise<TurnEffects> {
  const now = options.now ?? (() => new Date().toISOString());
  const nextEventId = options.nextEventId ?? createEventId;
  const { identity } = options;

  const context: ObservationContext = {
    workspaceRoot: identity.worktreeRoot,
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    worktreeId: identity.worktreeId,
  };

  const requestId = options.requestId ?? observationRequestId(options);
  const sidecarStatePath = join(identity.worktreeRoot, LEDGER_DIRECTORY, "observation", "sidecar.json");
  let sidecar: ObservationDrainResult | null = null;
  let sidecarAck: (() => Promise<void>) | undefined;
  let sidecarRetryPending = false;
  try {
    const client = await connectObservationSidecar(identity.worktreeRoot);
    sidecar = await client.drain(requestId, context);
    sidecarAck = () => client.ack(requestId, sidecar!.transactionId);
  } catch (error) {
    // IPC/startup is best effort; retain the historical full-capture fallback.
    // A timed-out drain may still be running in the sidecar. Falling back here would
    // race its durable result and emit the same file change twice. Keep the request
    // marker so the next drain retries the same transaction.
    sidecarRetryPending = error instanceof Error && error.message === "observation request timed out";
  }
  if (sidecarRetryPending) return { events: [], baselineOnly: false };
  let previous: ObservationSnapshot | null;
  let capture: ObservationCapture;
  let acknowledge: (() => Promise<void>) | undefined;
  let baselineOnly = false;
  if (sidecar !== null) {
    previous = sidecar.before.snapshot;
    capture = sidecar.capture;
    acknowledge = sidecarAck;
    baselineOnly = sidecar.baselineOnly;
  } else {
    const boundary = new NodeObservationBoundary({ source: options.source });
    capture = await boundary.captureAfter(context);
    previous = readSnapshot(options.snapshotPath);
    writeSnapshot(options.snapshotPath, capture.snapshot, now());
  }
  const timestamp = now();
  if (previous === null) return { events: [], baselineOnly: true, acknowledge };

  const diff = diffSnapshots(previous, capture.snapshot, false);
  const candidates = diff.changes.filter((change) => !isRecorderState(change.path));
  const ignored = ignoredByRepository(identity.worktreeRoot, candidates.map((change) => change.path));
  const calls = options.calls ?? [];
  const events = candidates
    .filter((change) => !ignored.has(change.path))
    .map((change) => {
      const owner = calls.length === 0 ? null : bindChange(identity.worktreeRoot, change, calls);
      return fileChangedEvent({
        change,
        identity,
        source: options.source,
        timestamp,
        // A bound change inherits the call's attribution, which is narrower than the turn's:
        // it names the agent that ran, which for a subagent is not the agent that owns the turn.
        agentId: owner?.agentId ?? options.agentId,
        taskId: owner?.taskId ?? options.taskId,
        // A bound change joins its call's correlation, because a child must inherit its
        // parent's correlation and the set validator enforces exactly that. An unbound change
        // gets one correlation of its own, not one per batch: it is its own causal root, and a
        // correlation may hold only one root, so sharing an id across a batch makes every event
        // after the first invalid. Per-event validation cannot see this; it is a set property.
        correlationId: owner?.correlationId
          ?? (sidecar === null
            ? createCorrelationId()
            : stableId("corr_", "patchmesh:file-change-correlation", `${requestId}\0${change.path}`) as CorrelationId),
        causationId: owner?.completionEventId ?? null,
        eventId: sidecar === null
          ? nextEventId()
          : stableId("evt_", "patchmesh:file-change", `${requestId}\0${change.path}\0${change.changeKind}\0${change.after?.contentHash ?? ""}`) as EventId,
        requestId,
      });
    });
  return { events, baselineOnly, acknowledge };
}

interface FileChangedEventOptions {
  readonly change: ObservedFileChange;
  readonly identity: RepositoryIdentity;
  readonly source: Source;
  readonly timestamp: string;
  readonly agentId: AgentId | null;
  readonly taskId: TaskId | null;
  readonly correlationId: CorrelationId;
  /** The completion this change was matched to, or null when no single call's window held it. */
  readonly causationId: EventId | null;
  readonly eventId: EventId;
  readonly requestId?: string;
}

function fileChangedEvent(options: FileChangedEventOptions): ProtocolEvent {
  const { change, identity, eventId } = options;
  const locator = normalizeLogicalPath(change.path);
  const resource = {
    resourceId: fileResourceId(identity.repositoryId, locator),
    repositoryId: identity.repositoryId,
    kind: "file" as const,
    locator,
  };
  const domain = {
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    worktreeId: identity.worktreeId,
  };
  const version = (state: ObservedFileState | null) => ({
    resourceId: resource.resourceId,
    domain,
    kind: state === null ? ("deleted" as const) : ("content_hash" as const),
    value: state?.contentHash ?? null,
    evidenceEventIds: [eventId],
  });

  return {
    schemaVersion: 1,
    eventId,
    eventType: "file.changed",
    source: options.source,
    timestamp: options.timestamp,
    ...domain,
    agentId: options.agentId,
    taskId: options.taskId,
    correlationId: options.correlationId,
    // Null unless exactly one call's window contained the write. An unmatched change was
    // observed between turns with no call the recorder can name, and inventing a link there
    // would assert an attribution that was never made.
    causationId: options.causationId,
    sourceSequence: null,
    payload: {
      resource,
      beforeVersion: change.before === null ? null : version(change.before),
      afterVersion: version(change.after),
      changeKind: change.changeKind,
      // The basis travels with the claim: "call" means a specific call was bound, "turn"
      // means only the turn is named. A causationId exists exactly when a call was bound,
      // so the label and the link cannot drift apart.
      attribution: options.causationId === null ? ("turn" as const) : ("call" as const),
    },
  } as unknown as ProtocolEvent;
}
