import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { realpathSync, statSync, watch, type BigIntStats, type FSWatcher } from "node:fs";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Source } from "patchmesh-protocol";
import { normalizeLogicalPath } from "./paths.js";
import { sanitizeDiagnostic } from "./redaction.js";
import type {
  ObservationBoundary,
  ObservationCapture,
  ObservationContext,
  ObservationGap,
  ObservationSnapshot,
  IncrementalObservationBoundary,
  ObservationWindow,
  ObservationWindowResult,
  ObservedFileState,
} from "./types.js";
import { diffSnapshots } from "./effects.js";
import { isIgnoredObservationPath } from "./ignore-policy.js";

const execFile = promisify(execFileCallback);

export interface NodeObservationOptions {
  readonly source: Source;
  readonly maxJournalEntries?: number;
  readonly quiescenceMs?: number;
  /**
   * The longest `endWindow` will keep waiting while watcher events are still arriving.
   *
   * `quiescenceMs` is how long the watcher must be *quiet* before a window is finalized, not
   * how long to wait in total -- so a busy filesystem can extend the wait indefinitely without
   * this cap. Reaching it means the window is finalized while events are still landing, which
   * reports as an `unattributed` gap rather than as a clean result.
   */
  readonly maxQuiescenceMs?: number;
  readonly reconciliationEveryWindows?: number;
  readonly watcherFactory?: (root: string, listener: (eventType: string, filename: string | Buffer | null) => void) => FSWatcher;
  readonly reconciliationScheduler?: (work: () => Promise<void>) => void;
  readonly candidateReader?: (path: string) => Promise<Buffer>;
}

interface GitMetadata {
  readonly commonDirectory: string | null;
  readonly administrativeDirectory: string | null;
  readonly revision: string | null;
  readonly gaps: readonly ObservationGap[];
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gap(kind: ObservationGap["kind"], scope: string, reason: string): ObservationGap {
  return { kind, scope, reason: sanitizeDiagnostic(reason) };
}

async function gitValue(root: string, ...args: string[]): Promise<string | null> {
  try {
    const result = await execFile("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * One spelling for a directory that decides repository identity.
 *
 * `git rev-parse --git-common-dir` answers *relatively* from a primary worktree (`.git`) and
 * *absolutely* from a linked one, and the absolute answer is the path the filesystem really
 * holds. Joining the relative answer onto a caller-supplied root therefore preserves whatever
 * spelling the caller used, so one repository reports two different common directories the
 * moment that root is an 8.3 short path, a symlink, or differently cased - and
 * `commonDirectory` is exactly the value used to decide that two worktrees are one repository.
 *
 * Observed on a GitHub Windows runner, whose TEMP is `C:\Users\RUNNER~1\...`: the primary
 * worktree reported `RUNNER~1` and the linked worktree `runneradmin`, for one repository.
 *
 * `realpathSync.native` returns the casing and long name the filesystem actually holds. Same
 * lesson and same fix as `canonicalPath` in the recorder, where two spellings of one checkout
 * once produced two worktree identities in real recorded data: never compare a host-supplied
 * path without canonicalizing it first.
 */
function canonicalDirectory(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    // Not resolvable on disk. The resolved-but-unverified path is still the better answer than
    // failing metadata capture outright; an absent directory is reported as a gap elsewhere.
    return value;
  }
}


async function captureGitMetadata(root: string): Promise<GitMetadata> {
  const commonDirectoryValue = await gitValue(root, "rev-parse", "--git-common-dir");
  const administrativeDirectoryValue = await gitValue(root, "rev-parse", "--git-dir");
  const revision = await gitValue(root, "rev-parse", "HEAD");
  const commonDirectory = commonDirectoryValue ? canonicalDirectory(resolve(root, commonDirectoryValue)) : null;
  const administrativeDirectory = administrativeDirectoryValue
    ? canonicalDirectory(resolve(root, administrativeDirectoryValue))
    : null;
  const gaps: ObservationGap[] = [];
  if (commonDirectory === null || administrativeDirectory === null || revision === null) {
    gaps.push(gap("unverified", "git", "Git repository metadata is unavailable"));
  }
  return { commonDirectory, administrativeDirectory, revision, gaps };
}

async function gitBlobHashes(root: string, paths: readonly string[]): Promise<ReadonlyMap<string, string> | null> {
  if (paths.length === 0) return new Map();
  if (paths.some((path) => path.includes("\n") || path.includes("\r"))) return null;

  return new Promise((resolveHashes) => {
    const child = spawn("git", ["hash-object", "--stdin-paths"], {
      cwd: root,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => resolveHashes(null));
    child.once("close", (code) => {
      if (code !== 0) {
        resolveHashes(null);
        return;
      }
      const hashes = stdout.trim().split(/\r?\n/);
      if (hashes.length !== paths.length || hashes.some((hash) => hash.length === 0)) {
        resolveHashes(null);
        return;
      }
      resolveHashes(new Map(paths.map((path, index) => [path, hashes[index]!])));
    });
    child.stdin.end(`${paths.join("\n")}\n`);
  });
}

function toLogicalPath(root: string, absolutePath: string): string {
  const relativePath = relative(root, absolutePath).split(sep).join("/");
  return normalizeLogicalPath(relativePath);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

async function hasSymlinkAncestor(root: string, logicalPath: string): Promise<boolean> {
  const segments = logicalPath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function captureFiles(root: string, includeGitBlobs: boolean): Promise<{
  readonly files: ReadonlyMap<string, ObservedFileState>;
  readonly metadata: ReadonlyMap<string, FileMetadata>;
  readonly gaps: readonly ObservationGap[];
}> {
  const files = new Map<string, ObservedFileState>();
  const metadata = new Map<string, FileMetadata>();
  const gaps: ObservationGap[] = [];
  const regularFiles: Array<{ readonly absolutePath: string; readonly relativePath: string; readonly logicalPath: string }> = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      gaps.push(gap("unverified", "filesystem", "A workspace directory could not be read"));
      return;
    }

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (isIgnoredObservationPath(relativePath)) continue;

      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      let logicalPath: string;
      try {
        logicalPath = toLogicalPath(root, absolutePath);
      } catch {
        gaps.push(gap("unverified", "filesystem", "A path is outside the logical workspace contract"));
        continue;
      }

      if (entry.isSymbolicLink()) {
        try {
          const target = await readlink(absolutePath);
          if (!isWithinRoot(root, resolve(dirname(absolutePath), target))) {
            gaps.push(gap("unverified", logicalPath, "A symbolic link target escapes the workspace root"));
            continue;
          }
          files.set(logicalPath, {
            contentHash: sha256(`symlink:${target}`),
            gitBlob: null,
            fileKind: "symlink",
          });
        } catch {
          gaps.push(gap("unverified", logicalPath, "A symbolic link target could not be observed"));
        }
        continue;
      }

      if (!entry.isFile()) {
        gaps.push(gap("unverified", logicalPath, "A workspace entry has an unsupported file type"));
        continue;
      }
      regularFiles.push({ absolutePath, relativePath, logicalPath });
    }
  }

  await visit(root);
  const blobHashes = includeGitBlobs ? await gitBlobHashes(root, regularFiles.map((file) => file.relativePath)) : null;
  const fallbackBlobs = includeGitBlobs && blobHashes === null
    ? await Promise.all(regularFiles.map((file) => gitValue(root, "hash-object", "--", file.relativePath)))
    : null;
  const concurrency = 32;
  let nextFile = 0;
  const fileStates: Array<ObservedFileState | null> = Array.from({ length: regularFiles.length }, () => null);
  const fileMetadata: Array<FileMetadata | null> = Array.from({ length: regularFiles.length }, () => null);
  const workers = Array.from({ length: Math.min(concurrency, regularFiles.length) }, async () => {
    while (nextFile < regularFiles.length) {
      const index = nextFile++;
      const file = regularFiles[index]!;
      try {
        const info = await lstat(file.absolutePath, { bigint: true });
        if (!info.isFile()) continue;
        fileStates[index] = {
          contentHash: sha256(await readFile(file.absolutePath)),
          gitBlob: blobHashes?.get(file.relativePath) ?? fallbackBlobs?.[index] ?? null,
          fileKind: "file",
        };
        fileMetadata[index] = metadataFromStat(info);
      } catch {
        // Preserve traversal order when publishing gaps below.
      }
    }
  });
  await Promise.all(workers);
  for (let index = 0; index < regularFiles.length; index += 1) {
    const file = regularFiles[index]!;
    const state = fileStates[index];
    if (state) {
      files.set(file.logicalPath, state);
      metadata.set(file.logicalPath, fileMetadata[index]!);
    }
    else gaps.push(gap("unverified", file.logicalPath, "A file content hash could not be computed"));
  }
  return { files, metadata, gaps };
}

interface WatchJournalEntry { readonly cursor: number; readonly path: string | null; }
interface FileMetadata { readonly size: string; readonly mtimeNs: string; readonly ino: string; }
interface IncrementalCapture { readonly capture: ObservationCapture; readonly metadata: Map<string, FileMetadata>; }
interface PathIdentity {
  readonly device: string;
  readonly inode: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly marker: string | null;
}
interface WorkspaceIdentity {
  readonly root: PathIdentity | null;
  readonly gitControl: PathIdentity | null;
}

function metadataFromStat(info: BigIntStats): FileMetadata {
  return { size: info.size.toString(), mtimeNs: info.mtimeNs.toString(), ino: info.ino.toString() };
}

function sameMetadata(left: FileMetadata | undefined, right: FileMetadata): boolean {
  return left !== undefined && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ino === right.ino;
}

async function capturePathIdentity(path: string): Promise<PathIdentity | null> {
  try {
    const info = await lstat(path, { bigint: true });
    const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
    const marker = kind === "file"
      ? sha256(await readFile(path))
      : kind === "symlink"
        ? await readlink(path)
        : null;
    return { device: info.dev.toString(), inode: info.ino.toString(), kind, marker };
  } catch {
    return null;
  }
}

async function captureWorkspaceIdentity(root: string): Promise<WorkspaceIdentity> {
  const [rootIdentity, gitControl] = await Promise.all([
    capturePathIdentity(root),
    capturePathIdentity(resolve(root, ".git")),
  ]);
  return { root: rootIdentity, gitControl };
}

function samePathIdentity(left: PathIdentity | null, right: PathIdentity | null): boolean {
  return left === null || right === null
    ? left === right
    : left.device === right.device && left.inode === right.inode && left.kind === right.kind && left.marker === right.marker;
}

function sameWorkspaceIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return left.root !== null
    && right.root !== null
    && samePathIdentity(left.root, right.root)
    && samePathIdentity(left.gitControl, right.gitControl);
}

interface WatchSession {
  readonly root: string;
  readonly context: ObservationContext;
  watcher: FSWatcher | null;
  journal: WatchJournalEntry[];
  cursor: number;
  activeCursor: number | null;
  degraded: ObservationGap | null;
  initialized: boolean;
  snapshot: ObservationSnapshot | null;
  completedWindows: number;
  processedCursor: number;
  outOfBandChanges: import("./types.js").ObservedFileChange[];
  pendingGaps: ObservationGap[];
  reconciliationScheduled: boolean;
  intentionalClose: boolean;
  metadata: Map<string, FileMetadata>;
  persistentGaps: ObservationGap[];
  identity: WorkspaceIdentity;
}

export class NodeObservationBoundary implements IncrementalObservationBoundary {
  readonly source: Source;
  private readonly sessions = new Map<string, WatchSession>();
  private readonly windowSessions = new WeakMap<ObservationWindow, WatchSession>();
  private readonly maxJournalEntries: number;
  private readonly quiescenceMs: number;
  private readonly maxQuiescenceMs: number;
  private readonly reconciliationEveryWindows: number;
  private readonly watcherFactory: NonNullable<NodeObservationOptions["watcherFactory"]>;
  private readonly reconciliationScheduler: NonNullable<NodeObservationOptions["reconciliationScheduler"]>;
  private readonly candidateReader: NonNullable<NodeObservationOptions["candidateReader"]>;

  constructor(options: NodeObservationOptions) {
    this.source = options.source;
    this.maxJournalEntries = options.maxJournalEntries ?? 10_000;
    this.quiescenceMs = options.quiescenceMs ?? 25;
    this.maxQuiescenceMs = options.maxQuiescenceMs ?? 2_000;
    this.reconciliationEveryWindows = options.reconciliationEveryWindows ?? 100;
    // Canonicalise inside the DEFAULT factory only, not in `session.root`.
    //
    // libuv's Windows watcher asserts, in C, that filenames `ReadDirectoryChangesW` reports
    // begin with the directory string it was handed:
    //
    //   Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\\win\\fs-event.c, line 72
    //
    // and calls `abort()` when they do not -- a native death no `try`/`catch`, `error`
    // listener or `uncaughtException` handler can intercept. A GitHub Windows runner reaches
    // that state because its TEMP is the 8.3 short name `C:\\Users\\RUNNER~1\\...` while the OS
    // reports changes under the long `C:\\Users\\runneradmin\\...`.
    //
    // Canonicalising `session.root` itself fixed that and broke something else: the root a
    // boundary hands to `watcherFactory` is part of its contract, and callers key on it.
    // `tools/phase2`'s M0 benchmark registers its stub watcher in a map under that root and
    // then notifies with the raw one it created, so rewriting it silently lost every event.
    //
    // Both constraints hold at once here, because only the real watcher is libuv. An injected
    // factory is a test double and must receive the root the caller passed in.
    this.watcherFactory =
      options.watcherFactory ?? ((root, listener) => watch(canonicalDirectory(root), { recursive: true }, listener));
    this.reconciliationScheduler = options.reconciliationScheduler ?? ((work) => { setImmediate(() => { void work(); }); });
    this.candidateReader = options.candidateReader ?? (async (path) => readFile(path));
  }

  async captureBefore(context: ObservationContext): Promise<ObservationCapture> {
    return this.capture(context, false);
  }

  async captureAfter(context: ObservationContext): Promise<ObservationCapture> {
    return this.capture(context, true);
  }

  async beginWindow(context: ObservationContext): Promise<ObservationWindow> {
    const session = await this.sessionFor(context);
    if (session.activeCursor !== null) {
      session.degraded = gap("overlapping_window", "observation.window", "overlapping attribution windows are not supported");
      const before = session.snapshot === null
        ? await this.capture(context, false)
        : { snapshot: session.snapshot, gaps: [session.degraded], outOfBandChanges: [] };
      return { workspaceId: context.workspaceId, cursor: session.cursor, before };
    }
    if (session.snapshot === null) {
      const initial = await this.captureState(context, false, false);
      session.snapshot = initial.capture.snapshot;
      session.metadata = new Map(initial.metadata);
      session.persistentGaps = initial.capture.gaps.filter((item) => item.scope !== "tool.effects");
    }
    await this.drainOutOfBand(session);
    const before: ObservationCapture = {
      snapshot: session.snapshot,
      gaps: this.uniqueGaps([...session.persistentGaps, ...session.pendingGaps.splice(0), ...(session.degraded === null ? [] : [session.degraded])]),
      outOfBandChanges: session.outOfBandChanges.splice(0),
    };
    session.activeCursor = session.processedCursor;
    const window = { workspaceId: context.workspaceId, cursor: session.processedCursor, before };
    this.windowSessions.set(window, session);
    return window;
  }

  /**
   * Wait for the watcher to go *quiet*, rather than for a fixed span of wall clock.
   *
   * `endWindow` used to sleep `quiescenceMs` once and then finalize. That is a bet that every
   * watcher event for the work just done arrives inside a fixed window, and `fs.watch` delivery
   * is bounded by nothing: a loaded runner with a virtualised disk and a scanner in the path
   * takes an order of magnitude longer than an idle developer machine. When the bet lost, the
   * late events landed after `drainCursor` was taken, which reports as an `unattributed` gap
   * and degrades a window that was actually observed correctly. That made every assertion of
   * `sufficient` coverage an assertion about how fast the machine was -- the same shape as the
   * 50ms delivery bound removed in `fd6f92a`.
   *
   * The cursor is the signal that was there all along: it advances as watcher events land. So
   * wait one `quiescenceMs` interval, and if nothing arrived in it, the watcher is quiet and
   * the window can close. If something did arrive, wait again. On an idle machine this costs
   * exactly what the old fixed sleep cost -- one interval -- and it extends only while events
   * are genuinely still coming.
   *
   * `maxQuiescenceMs` bounds the total, because a genuinely busy workspace could otherwise hold
   * a window open indefinitely. Hitting the cap is not silent: the events that arrive after it
   * still push the `unattributed` gap, which is the honest report that this window was closed
   * while the filesystem was still moving.
   */
  private async awaitQuiescence(session: WatchSession): Promise<void> {
    if (this.quiescenceMs <= 0) return;
    const deadline = Date.now() + this.maxQuiescenceMs;
    let seen = session.cursor;
    for (;;) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.quiescenceMs));
      if (session.cursor === seen) return;
      seen = session.cursor;
      if (Date.now() >= deadline) return;
    }
  }

  async endWindow(window: ObservationWindow): Promise<ObservationWindowResult> {
    const session = this.sessions.get(window.workspaceId);
    const owningSession = this.windowSessions.get(window);
    if (session === undefined || owningSession !== session || session.activeCursor !== window.cursor) {
      this.windowSessions.delete(window);
      return this.staleWindowResult(window);
    }
    try {
      await this.awaitQuiescence(session);
      if (this.sessions.get(window.workspaceId) !== session) return this.staleWindowResult(window);
      const drainCursor = session.cursor;
      const incremental = await this.captureIncremental(session, window.cursor, drainCursor);
      const capture = incremental.capture;
      if (this.sessions.get(window.workspaceId) !== session) return this.staleWindowResult(window);
      session.snapshot = capture.snapshot;
      session.metadata = incremental.metadata;
      session.persistentGaps = this.uniqueGaps([...session.persistentGaps, ...capture.gaps.filter((item) => item.scope !== "tool.effects")]);
      session.processedCursor = drainCursor;
      this.pruneJournal(session);
      const gaps = [
        ...window.before.gaps,
        ...capture.gaps,
        ...(session.degraded === null ? [] : [session.degraded]),
      ];
      if (session.cursor > drainCursor) {
        gaps.push(gap("unattributed", "observation.window", "watcher events arrived while the completed window was being finalized"));
      }
      session.completedWindows += 1;
      if (session.completedWindows % this.reconciliationEveryWindows === 0) this.scheduleFullReconciliation(session);
      const uniqueGaps = this.uniqueGaps(gaps);
      const degraded = uniqueGaps.some((item) => !(item.kind === "unverified" && item.scope === "tool.effects"));
      if (session.degraded?.kind === "overlapping_window") session.degraded = null;
      return { capture: { ...capture, gaps: uniqueGaps }, completeness: degraded ? "degraded" : "complete", reconciliationRequired: degraded };
    } finally {
      this.windowSessions.delete(window);
      if (this.sessions.get(window.workspaceId) === session && session.activeCursor === window.cursor) session.activeCursor = null;
    }
  }

  async dispose(workspaceId?: string): Promise<void> {
    const sessions = workspaceId === undefined ? [...this.sessions.values()] : [this.sessions.get(workspaceId)].filter((value): value is WatchSession => value !== undefined);
    for (const session of sessions) {
      session.intentionalClose = true;
      session.watcher?.close();
    }
    if (workspaceId === undefined) this.sessions.clear(); else this.sessions.delete(workspaceId);
  }

  private async sessionFor(context: ObservationContext): Promise<WatchSession> {
    const existing = this.sessions.get(context.workspaceId);
    const root = resolve(context.workspaceRoot);
    const identityMatches = existing !== undefined
      && existing.root === root
      && existing.context.repositoryId === context.repositoryId
      && existing.context.worktreeId === context.worktreeId;
    if (identityMatches) return existing;
    if (existing !== undefined) {
      existing.intentionalClose = true;
      existing.watcher?.close();
    }
    const identityChanged = existing !== undefined;
    const session: WatchSession = {
      root,
      context,
      watcher: null,
      journal: [],
      cursor: 0,
      activeCursor: null,
      degraded: identityChanged ? gap("root_replaced", "workspace", "workspace root or logical identity changed for an existing observation session") : null,
      initialized: false,
      snapshot: null,
      completedWindows: identityChanged ? this.reconciliationEveryWindows - 1 : 0,
      processedCursor: 0,
      outOfBandChanges: [],
      pendingGaps: [],
      reconciliationScheduled: false,
      intentionalClose: false,
      metadata: new Map(),
      persistentGaps: [],
      identity: { root: null, gitControl: null },
    };
    try {
      // Refuse to hand `fs.watch` anything that is not, right now, a directory.
      //
      // libuv's Windows watcher branches on `uv__is_dir(path)`. The directory branch is safe;
      // the other branch watches the parent and calls `uv__relative_path`, whose first act is
      // a C assertion that the path begins with that parent:
      //
      //   Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\wins-event.c, line 72
      //
      // A failed assertion there is `abort()` -- a native death that no `try`/`catch`, `error`
      // listener or `uncaughtException` handler can intercept, and which takes the host process
      // with it. This project's founding rule for the recorder is that an observer which can
      // break the agent gets uninstalled, and a process abort is the most complete way to break
      // one. So the cheap check that keeps execution out of that branch is worth its cost.
      //
      // It is also honest about what it cannot promise: this closes the reachable path into the
      // assertion, it does not make `fs.watch` unable to abort. A gap is recorded rather than
      // throwing, because a workspace that is not a directory is a degraded observation, not a
      // failed one.
      const stats = statSync(session.root, { throwIfNoEntry: false });
      if (stats === undefined || !stats.isDirectory()) {
        throw new Error("workspace root is not a directory");
      }
      session.watcher = this.watcherFactory(session.root, (_event, filename) => {
        session.cursor += 1;
        session.journal.push({ cursor: session.cursor, path: filename === null ? null : filename.toString() });
        if (session.journal.length > this.maxJournalEntries) {
          session.journal.splice(0, session.journal.length - this.maxJournalEntries);
          session.degraded = gap("watcher_overflow", "filesystem", "watcher journal exceeded its bounded capacity");
        }
      });
      session.watcher.on("error", () => { session.degraded = gap("watcher_unavailable", "filesystem", "workspace watcher failed"); });
      session.watcher.on("close", () => {
        if (!session.intentionalClose) session.degraded = gap("watcher_unavailable", "filesystem", "workspace watcher closed unexpectedly");
      });
    } catch {
      session.degraded = gap("watcher_unavailable", "filesystem", "recursive workspace watcher is unavailable");
    }
    session.identity = await captureWorkspaceIdentity(session.root);
    session.initialized = true;
    this.sessions.set(context.workspaceId, session);
    return session;
  }

  private async captureIncremental(session: WatchSession, cursor: number, throughCursor: number): Promise<IncrementalCapture> {
    const before = session.snapshot;
    if (before === null) {
      const full = await this.captureState(session.context, true, false);
      return { capture: full.capture, metadata: new Map(full.metadata) };
    }
    const files = new Map(before.files);
    const metadata = new Map(session.metadata);
    const hashedCandidates = new Set<string>();
    const gaps: ObservationGap[] = [gap("unverified", "tool.effects", "snapshot observation verifies final state but cannot prove each effect originated from the intercepted operation")];
    const currentIdentity = await captureWorkspaceIdentity(session.root);
    let identityChanged = false;
    const markIdentityChanged = (): void => {
      identityChanged = true;
      const replacementGap = gap("root_replaced", "workspace", "workspace root or on-disk Git identity changed for an existing observation session");
      if (!gaps.some((item) => item.kind === replacementGap.kind && item.scope === replacementGap.scope && item.reason === replacementGap.reason)) gaps.push(replacementGap);
      session.degraded = replacementGap;
      session.completedWindows = this.reconciliationEveryWindows - 1;
    };
    if (!sameWorkspaceIdentity(session.identity, currentIdentity)) markIdentityChanged();
    const paths = new Set<string>();
    for (const entry of session.journal.filter((item) => item.cursor > cursor && item.cursor <= throughCursor)) {
      if (entry.path === null) {
        gaps.push(gap("unverified", "filesystem", "watcher did not provide a changed path"));
        continue;
      }
      try {
        const logicalPath = normalizeLogicalPath(entry.path.replaceAll("\\", "/"));
        if (!isIgnoredObservationPath(logicalPath)) paths.add(logicalPath);
      } catch {
        gaps.push(gap("unverified", "filesystem", "watcher path is unsafe"));
      }
    }
    const orderedPaths = [...paths].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
    for (const logicalPath of orderedPaths) {
      const absolute = resolve(session.root, logicalPath);
      if (!isWithinRoot(session.root, absolute)) { gaps.push(gap("unverified", logicalPath, "watcher path escaped workspace root")); continue; }
      if (await hasSymlinkAncestor(session.root, logicalPath)) { gaps.push(gap("unverified", logicalPath, "watcher path has a symbolic-link ancestor and requires full reconciliation")); continue; }
      try {
        const info = await lstat(absolute, { bigint: true });
        if (info.isSymbolicLink()) { gaps.push(gap("unverified", logicalPath, "symlink changes require full reconciliation")); continue; }
        if (!info.isFile()) {
          if (info.isDirectory()) {
            await this.scanDirectoryCandidate(session, logicalPath, files, metadata, gaps, hashedCandidates);
            continue;
          }
          gaps.push(gap("unverified", logicalPath, "watcher path is not a regular file"));
          continue;
        }
        if (!hashedCandidates.has(logicalPath)) {
          files.set(logicalPath, { contentHash: sha256(await this.candidateReader(absolute)), gitBlob: null, fileKind: "file" });
          hashedCandidates.add(logicalPath);
        }
        metadata.set(logicalPath, metadataFromStat(info));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          for (const path of [...files.keys()]) if (path === logicalPath || path.startsWith(`${logicalPath}/`)) files.delete(path);
          for (const path of [...metadata.keys()]) if (path === logicalPath || path.startsWith(`${logicalPath}/`)) metadata.delete(path);
        }
        else gaps.push(gap("unverified", logicalPath, "changed candidate could not be read"));
      }
    }
    const candidatePaths = [...hashedCandidates].sort((left, right) => left.localeCompare(right));
    let revision = before.repository.revision;
    if (!identityChanged) {
      const identityBeforeGit = await captureWorkspaceIdentity(session.root);
      if (!sameWorkspaceIdentity(session.identity, identityBeforeGit) || !sameWorkspaceIdentity(currentIdentity, identityBeforeGit)) {
        markIdentityChanged();
      } else {
        const blobs = candidatePaths.length > 0 && before.repository.commonDirectory !== null && before.worktree.administrativeDirectory !== null
          ? await gitBlobHashes(session.root, candidatePaths)
          : new Map<string, string>();
        const fallback = blobs === null
          ? await Promise.all(candidatePaths.map((path) => gitValue(session.root, "hash-object", "--", path)))
          : null;
        const resolvedRevision = await gitValue(session.root, "rev-parse", "HEAD");
        const identityAfterGit = await captureWorkspaceIdentity(session.root);
        if (!sameWorkspaceIdentity(identityBeforeGit, identityAfterGit) || !sameWorkspaceIdentity(session.identity, identityAfterGit)) {
          markIdentityChanged();
        } else {
          revision = resolvedRevision;
          if (revision === null) gaps.push(gap("unverified", "git", "Git revision metadata is unavailable"));
          for (let index = 0; index < candidatePaths.length; index += 1) {
            const path = candidatePaths[index]!;
            const state = files.get(path);
            if (state !== undefined) files.set(path, { ...state, gitBlob: blobs?.get(path) ?? fallback?.[index] ?? null });
          }
        }
      }
    }
    for (const directory of [before.repository.commonDirectory, before.worktree.administrativeDirectory]) {
      if (directory === null) continue;
      try { await lstat(directory); } catch { gaps.push(gap("root_replaced", "workspace", "cached repository or worktree administration is unavailable")); }
    }
    const snapshot: ObservationSnapshot = {
      repository: { commonDirectory: before.repository.commonDirectory, revision },
      worktree: { administrativeDirectory: before.worktree.administrativeDirectory },
      files,
    };
    return { capture: { snapshot, gaps, outOfBandChanges: [] }, metadata };
  }

  private async scanDirectoryCandidate(
    session: WatchSession,
    logicalDirectory: string,
    files: Map<string, ObservedFileState>,
    metadata: Map<string, FileMetadata>,
    gaps: ObservationGap[],
    hashedCandidates: Set<string>,
  ): Promise<void> {
    const observed = new Set<string>();
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        gaps.push(gap("unverified", logicalDirectory, "changed directory candidate could not be read"));
        return;
      }
      for (const entry of entries) {
        const absolute = resolve(directory, entry.name);
        let logicalPath: string;
        try {
          logicalPath = toLogicalPath(session.root, absolute);
        } catch {
          gaps.push(gap("unverified", logicalDirectory, "changed directory contains an unsafe path"));
          continue;
        }
        if (isIgnoredObservationPath(logicalPath)) continue;
        if (entry.isDirectory()) {
          await visit(absolute);
          continue;
        }
        observed.add(logicalPath);
        if (entry.isSymbolicLink()) {
          gaps.push(gap("unverified", logicalPath, "symlink changes require full reconciliation"));
          continue;
        }
        if (!entry.isFile()) {
          gaps.push(gap("unverified", logicalPath, "changed directory contains an unsupported entry"));
          continue;
        }
        try {
          const info = await lstat(absolute, { bigint: true });
          if (!info.isFile()) {
            gaps.push(gap("unverified", logicalPath, "directory candidate changed kind during observation"));
            continue;
          }
          const nextMetadata = metadataFromStat(info);
          if (!sameMetadata(metadata.get(logicalPath), nextMetadata)) {
            files.set(logicalPath, { contentHash: sha256(await this.candidateReader(absolute)), gitBlob: null, fileKind: "file" });
            metadata.set(logicalPath, nextMetadata);
            hashedCandidates.add(logicalPath);
          }
        } catch {
          gaps.push(gap("unverified", logicalPath, "changed directory file could not be read"));
        }
      }
    };
    await visit(resolve(session.root, logicalDirectory));
    gaps.push(gap("unverified", logicalDirectory, "watcher supplied only a directory candidate; unchanged descendants were not content-hashed"));
    const prefix = `${logicalDirectory}/`;
    for (const path of [...files.keys()]) {
      if (path.startsWith(prefix) && !observed.has(path)) files.delete(path);
    }
    for (const path of [...metadata.keys()]) {
      if (path.startsWith(prefix) && !observed.has(path)) metadata.delete(path);
    }
  }

  private async drainOutOfBand(session: WatchSession): Promise<void> {
    const maximumDrainPasses = 8;
    for (let pass = 0; pass < maximumDrainPasses && session.cursor > session.processedCursor; pass += 1) {
      const throughCursor = session.cursor;
      const previous = session.snapshot!;
      const reconciled = await this.captureIncremental(session, session.processedCursor, throughCursor);
      session.snapshot = reconciled.capture.snapshot;
      session.metadata = reconciled.metadata;
      session.outOfBandChanges.push(...diffSnapshots(previous, reconciled.capture.snapshot, false).changes.map((change) => ({ ...change, outOfBand: true })));
      session.persistentGaps = this.uniqueGaps([...session.persistentGaps, ...reconciled.capture.gaps.filter((item) => item.scope !== "tool.effects")]);
      session.processedCursor = throughCursor;
      this.pruneJournal(session);
    }
    if (session.cursor > session.processedCursor) {
      session.pendingGaps.push(gap("unattributed", "observation.window", "watcher activity did not quiesce before the observation window began"));
    }
  }

  private scheduleFullReconciliation(session: WatchSession): void {
    if (session.reconciliationScheduled) return;
    session.reconciliationScheduled = true;
    const work = async (): Promise<void> => {
      try {
        if (this.sessions.get(session.context.workspaceId) !== session) return;
        if (session.activeCursor !== null) {
          session.pendingGaps.push(gap("unverified", "filesystem", "periodic reconciliation could not run outside an active window"));
          session.completedWindows = Math.max(0, session.completedWindows - 1);
          return;
        }
        const throughCursor = session.cursor;
        const previous = session.snapshot!;
        const incremental = throughCursor > session.processedCursor
          ? await this.captureIncremental(session, session.processedCursor, throughCursor)
          : { capture: { snapshot: previous, gaps: [], outOfBandChanges: [] }, metadata: new Map(session.metadata) };
        const identityBeforeFull = await captureWorkspaceIdentity(session.root);
        const identityReplacedBeforeFull = !sameWorkspaceIdentity(session.identity, identityBeforeFull);
        const full = await this.captureState(session.context, true, false);
        const identityAfterFull = await captureWorkspaceIdentity(session.root);
        if (this.sessions.get(session.context.workspaceId) !== session || session.activeCursor !== null || session.cursor !== throughCursor) {
          session.pendingGaps.push(gap("unverified", "filesystem", "workspace changed while periodic reconciliation was running"));
          session.completedWindows = Math.max(0, session.completedWindows - 1);
          return;
        }
        if (!sameWorkspaceIdentity(identityBeforeFull, identityAfterFull)) {
          session.pendingGaps.push(gap("root_replaced", "workspace", "workspace root or on-disk Git identity changed while periodic reconciliation was running"));
          session.completedWindows = Math.max(0, session.completedWindows - 1);
          return;
        }
        if (identityReplacedBeforeFull) {
          session.pendingGaps.push(gap("root_replaced", "workspace", "workspace root or on-disk Git identity changed before periodic reconciliation"));
        }
        session.persistentGaps = this.uniqueGaps([...session.persistentGaps, ...incremental.capture.gaps.filter((item) => item.scope !== "tool.effects")]);
        if (!sameSnapshot(incremental.capture.snapshot, full.capture.snapshot)) {
          session.pendingGaps.push(gap("reconciliation_mismatch", "filesystem", "incremental cache does not match full reconciliation"));
        }
        session.outOfBandChanges.push(...diffSnapshots(previous, full.capture.snapshot, false).changes.map((change) => ({ ...change, outOfBand: true })));
        session.snapshot = full.capture.snapshot;
        session.metadata = new Map(full.metadata);
        session.identity = identityAfterFull;
        session.persistentGaps = full.capture.gaps.filter((item) => item.scope !== "tool.effects");
        session.processedCursor = throughCursor;
        this.pruneJournal(session);
        if (((session.degraded?.kind === "root_replaced")
          || (sameSnapshot(incremental.capture.snapshot, full.capture.snapshot) && session.degraded?.kind === "watcher_overflow"))
          && full.capture.gaps.every((item) => item.scope === "tool.effects" || item.scope === "git")) {
          session.degraded = null;
        }
      } catch {
        session.pendingGaps.push(gap("reconciliation_mismatch", "filesystem", "periodic full reconciliation failed"));
        session.completedWindows = Math.max(0, session.completedWindows - 1);
      } finally {
        session.reconciliationScheduled = false;
      }
    };
    try {
      this.reconciliationScheduler(work);
    } catch {
      session.reconciliationScheduled = false;
      session.pendingGaps.push(gap("reconciliation_mismatch", "filesystem", "periodic full reconciliation could not be scheduled"));
    }
  }

  private staleWindowResult(window: ObservationWindow): ObservationWindowResult {
    return {
      capture: {
        ...window.before,
        gaps: this.uniqueGaps([...window.before.gaps, gap("overlapping_window", "observation.window", "window is stale or no longer active")]),
      },
      completeness: "degraded",
      reconciliationRequired: true,
    };
  }

  private uniqueGaps(gaps: readonly ObservationGap[]): ObservationGap[] {
    const seen = new Set<string>();
    return gaps.filter((item) => {
      const identity = `${item.kind}\u0000${item.scope}\u0000${item.reason}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }

  private pruneJournal(session: WatchSession): void {
    const firstUnprocessed = session.journal.findIndex((entry) => entry.cursor > session.processedCursor);
    if (firstUnprocessed < 0) session.journal.length = 0;
    else if (firstUnprocessed > 0) session.journal.splice(0, firstUnprocessed);
  }

  private async capture(context: ObservationContext, afterExecution: boolean): Promise<ObservationCapture> {
    return (await this.captureState(context, afterExecution, true)).capture;
  }

  private async captureState(context: ObservationContext, afterExecution: boolean, includeGitBlobs: boolean): Promise<{
    readonly capture: ObservationCapture;
    readonly metadata: ReadonlyMap<string, FileMetadata>;
  }> {
    const root = resolve(context.workspaceRoot);
    const git = await captureGitMetadata(root);
    const files = await captureFiles(root, includeGitBlobs && git.commonDirectory !== null && git.administrativeDirectory !== null);
    const snapshot: ObservationSnapshot = {
      repository: {
        commonDirectory: git.commonDirectory,
        revision: git.revision,
      },
      worktree: {
        administrativeDirectory: git.administrativeDirectory,
      },
      files: files.files,
    };
    return {
      capture: {
        snapshot,
        gaps: [
          ...git.gaps,
          ...files.gaps,
          ...(afterExecution
            ? [gap(
                "unverified",
                "tool.effects",
                "snapshot observation verifies final state but cannot prove each effect originated from the intercepted operation",
              )]
            : []),
        ],
        outOfBandChanges: [],
      },
      metadata: files.metadata,
    };
  }
}

function sameSnapshot(left: ObservationSnapshot, right: ObservationSnapshot): boolean {
  if (left.repository.commonDirectory !== right.repository.commonDirectory || left.worktree.administrativeDirectory !== right.worktree.administrativeDirectory || left.files.size !== right.files.size) return false;
  for (const [path, state] of left.files) {
    const other = right.files.get(path);
    if (other === undefined || other.contentHash !== state.contentHash || other.fileKind !== state.fileKind) return false;
  }
  return true;
}
