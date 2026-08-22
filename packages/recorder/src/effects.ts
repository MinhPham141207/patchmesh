import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  diffSnapshots,
  fileResourceId,
  NodeObservationBoundary,
  normalizeLogicalPath,
  type ObservationContext,
  type ObservationSnapshot,
  type ObservedFileChange,
  type ObservedFileState,
} from "@patchmesh/observation";
import type { AgentId, EventId, ProtocolEvent, Source, TaskId } from "@patchmesh/protocol";
import { createCorrelationId, createEventId, type RepositoryIdentity } from "./identity.js";
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
  writeFileSync(snapshotPath, JSON.stringify(stored), "utf8");
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
}

export interface TurnEffects {
  readonly events: readonly ProtocolEvent[];
  /** Set when the baseline was missing, so this run only established one. */
  readonly baselineOnly: boolean;
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

  const boundary = new NodeObservationBoundary({ source: options.source });
  const capture = await boundary.captureAfter(context);
  const timestamp = now();

  const previous = readSnapshot(options.snapshotPath);
  writeSnapshot(options.snapshotPath, capture.snapshot, timestamp);
  if (previous === null) return { events: [], baselineOnly: true };

  const diff = diffSnapshots(previous, capture.snapshot, false);
  const events = diff.changes
    .filter((change) => !isRecorderState(change.path))
    .map((change) =>
    fileChangedEvent({
      change,
      identity,
      source: options.source,
      timestamp,
      agentId: options.agentId,
      taskId: options.taskId,
      // One correlation per change, not one per batch. Each observed change is its own causal
      // root - nothing in the recorded stream caused it - and a correlation may hold only one
      // root, so sharing an id across a batch makes every event after the first invalid. Per
      // event validation cannot see this; it is a property of the set.
      correlationId: createCorrelationId(),
      eventId: nextEventId(),
    }),
    );
  return { events, baselineOnly: false };
}

interface FileChangedEventOptions {
  readonly change: ObservedFileChange;
  readonly identity: RepositoryIdentity;
  readonly source: Source;
  readonly timestamp: string;
  readonly agentId: AgentId | null;
  readonly taskId: TaskId | null;
  readonly correlationId: ReturnType<typeof createCorrelationId>;
  readonly eventId: EventId;
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
    // Nothing caused this in the recorded stream. The change was observed between turns, not
    // produced by a call the recorder can name, and inventing a causation link would assert
    // an attribution that was never made.
    causationId: null,
    sourceSequence: null,
    payload: {
      resource,
      beforeVersion: change.before === null ? null : version(change.before),
      afterVersion: version(change.after),
      changeKind: change.changeKind,
    },
  } as unknown as ProtocolEvent;
}
