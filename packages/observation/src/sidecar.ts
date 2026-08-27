import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { access, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { NodeObservationBoundary } from "./node-observation.js";
import type {
  ObservationCapture,
  ObservationContext,
  ObservationGap,
  ObservationSnapshot,
  ObservationWindowResult,
  ObservedFileChange,
  ObservedFileState,
} from "./types.js";
import type { Source } from "patchmesh-protocol";

export interface ObservationDrainResult {
  readonly requestId: string;
  readonly transactionId: string;
  readonly preparedAt: string;
  /** True when this drain established the first durable snapshot. */
  readonly baselineOnly: boolean;
  readonly before: ObservationCapture;
  readonly capture: ObservationCapture;
  readonly completeness: ObservationWindowResult["completeness"];
  readonly reconciliationRequired: boolean;
}

export interface ObservationSidecarOptions {
  readonly source?: Source;
  readonly stateDirectory?: string;
  readonly boundary?: NodeObservationBoundary;
}

export interface ObservationSidecarServer {
  readonly address: string;
  close(): Promise<void>;
}

interface PersistedCapture {
  readonly snapshot: {
    readonly repository: ObservationSnapshot["repository"];
    readonly worktree: ObservationSnapshot["worktree"];
    readonly files: readonly [string, ObservedFileState][];
  };
  readonly gaps: readonly ObservationGap[];
  readonly outOfBandChanges: readonly ObservedFileChange[];
}

interface PersistedDrainResult {
  readonly requestId: string;
  readonly transactionId: string;
  readonly preparedAt: string;
  readonly baselineOnly?: boolean;
  readonly before: PersistedCapture;
  readonly capture: PersistedCapture;
  readonly completeness: ObservationWindowResult["completeness"];
  readonly reconciliationRequired: boolean;
}

interface PersistedResult {
  readonly transactionId: string;
  readonly result: PersistedDrainResult;
}

interface PersistedState {
  readonly version: 1;
  readonly committed: readonly string[];
  readonly preparedAt: Readonly<Record<string, string>>;
  readonly latest: PersistedCapture | null;
  readonly pending: Readonly<Record<string, PersistedResult>>;
}

interface LoadedState {
  readonly state: PersistedState;
  readonly valid: boolean;
}

const EMPTY_STATE: PersistedState = { version: 1, committed: [], preparedAt: {}, latest: null, pending: {} };
const STALE_LOCK_MS = 5 * 60 * 1000;
const instances = new Map<string, ObservationSidecar>();
const servers = new Map<string, ObservationSidecarServer>();

function tokenPath(root: string): string {
  return resolve(root, ".patchmesh", "observation", "sidecar.token");
}

function socketPath(root: string): string {
  const name = `patchmesh-observation-${hashId(resolve(root)).slice(0, 24)}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function serializeCapture(capture: ObservationCapture): PersistedCapture {
  return {
    snapshot: {
      repository: capture.snapshot.repository,
      worktree: capture.snapshot.worktree,
      files: [...capture.snapshot.files.entries()],
    },
    gaps: capture.gaps,
    outOfBandChanges: capture.outOfBandChanges,
  };
}

function deserializeCapture(capture: PersistedCapture): ObservationCapture {
  return {
    snapshot: {
      repository: capture.snapshot.repository,
      worktree: capture.snapshot.worktree,
      files: new Map(capture.snapshot.files),
    },
    gaps: capture.gaps,
    outOfBandChanges: capture.outOfBandChanges,
  };
}

function serializeResult(result: ObservationDrainResult): PersistedResult {
  return {
    transactionId: result.transactionId,
    result: {
      requestId: result.requestId,
      transactionId: result.transactionId,
      preparedAt: result.preparedAt,
      baselineOnly: result.baselineOnly,
      before: serializeCapture(result.before),
      capture: serializeCapture(result.capture),
      completeness: result.completeness,
      reconciliationRequired: result.reconciliationRequired,
    },
  };
}

function deserializeResult(result: PersistedResult): ObservationDrainResult {
  return {
    ...result.result,
    baselineOnly: result.result.baselineOnly === true,
    before: deserializeCapture(result.result.before),
    capture: deserializeCapture(result.result.capture),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapture(value: unknown): value is PersistedCapture {
  if (!isRecord(value) || !isRecord(value.snapshot) || !Array.isArray(value.snapshot.files)) return false;
  return Array.isArray(value.gaps) && Array.isArray(value.outOfBandChanges);
}

function isPersistedState(value: unknown): value is PersistedState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.committed) || !isRecord(value.pending)) return false;
  if (value.latest !== null && !isCapture(value.latest)) return false;
  return Object.values(value.pending).every((item) => isRecord(item) && typeof item.transactionId === "string" && isRecord(item.result)
    && (item.result.baselineOnly === undefined || typeof item.result.baselineOnly === "boolean")
    && isCapture(item.result.before) && isCapture(item.result.capture));
}

async function readState(path: string): Promise<LoadedState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isPersistedState(parsed)) return { state: EMPTY_STATE, valid: false };
    return { state: {
      version: 1,
      committed: parsed.committed.filter((value): value is string => typeof value === "string").slice(-1024),
      preparedAt: isRecord(parsed.preparedAt) ? Object.fromEntries(Object.entries(parsed.preparedAt).filter(([, value]) => typeof value === "string").slice(-1024)) : {},
      latest: parsed.latest,
      pending: parsed.pending,
    }, valid: true };
  } catch (error) {
    return { state: EMPTY_STATE, valid: (error as NodeJS.ErrnoException).code === "ENOENT" };
  }
}

async function writeState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), "utf8");
  await rename(temporary, path);
}

async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let handle;
  for (let attempt = 0; ; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 250) throw error;
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  try {
    return await work();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

function defaultSource(): Source {
  return { kind: "watcher", sourceId: "source_observation_sidecar", instanceId: randomUUID() };
}

export class ObservationSidecar {
  readonly boundary: NodeObservationBoundary;
  private readonly statePath: string;
  private readonly lockPath: string;
  private state: PersistedState = EMPTY_STATE;
  private stateNeedsRecovery = false;
  private restored = false;
  private queue: Promise<unknown> = Promise.resolve();

  private readonly root: string;

  constructor(root: string, options: ObservationSidecarOptions = {}) {
    this.root = resolve(root);
    this.boundary = options.boundary ?? new NodeObservationBoundary({ source: options.source ?? defaultSource() });
    const directory = options.stateDirectory ?? resolve(this.root, ".patchmesh", "observation");
    this.statePath = resolve(directory, "sidecar.json");
    this.lockPath = `${this.statePath}.lock`;
  }

  async start(): Promise<this> {
    const loaded = await withLock(this.lockPath, () => readState(this.statePath));
    this.state = loaded.state;
    this.stateNeedsRecovery = !loaded.valid;
    return this;
  }

  async drain(requestId: string, context: ObservationContext): Promise<ObservationDrainResult> {
    if (!requestId) throw new Error("requestId is required");
    if (this.root !== resolve(context.workspaceRoot)) throw new Error("observation context root mismatch");
    return this.serialized(async () => {
      return withLock(this.lockPath, async () => {
        const loaded = await readState(this.statePath);
        this.state = loaded.state;
        this.stateNeedsRecovery ||= !loaded.valid;
        const existing = this.state.pending[requestId];
        if (existing) return deserializeResult(existing);
        if (this.state.committed.includes(requestId) && this.state.latest) {
          const capture = deserializeCapture(this.state.latest);
          return {
            requestId,
            transactionId: hashId(`${this.root}\0${requestId}`),
            preparedAt: this.state.preparedAt[requestId] ?? "1970-01-01T00:00:00.000Z",
            baselineOnly: false,
            before: capture,
            capture,
            completeness: "complete",
            reconciliationRequired: false,
          };
        }
        let restored = false;
        let restoredBefore: ObservationCapture | null = null;
        if (this.state.latest && !this.restored) {
          restoredBefore = deserializeCapture(this.state.latest);
          await this.boundary.restoreSnapshot(context, restoredBefore);
          if (typeof this.boundary.reconcile === "function") await this.boundary.reconcile(context);
          this.restored = true;
          restored = true;
        }
        const window = await this.boundary.beginWindow(context);
        const ended = await this.boundary.endWindow(window);
        const recoveryGap: ObservationGap = {
          kind: "reconciliation_mismatch",
          scope: "filesystem",
          reason: "observation sidecar state was missing or invalid; full reconciliation required",
        };
        const gaps = [
          ...ended.capture.gaps,
          ...(this.stateNeedsRecovery || this.state.latest === null ? [recoveryGap] : []),
          ...(restored ? [{
            kind: "reconciliation_mismatch" as const,
            scope: "filesystem",
            reason: "observation sidecar restarted; full reconciliation was performed",
          }] : []),
        ];
        const capture = { ...ended.capture, gaps };
        this.restored = true;
        const result: ObservationDrainResult = {
          requestId,
          transactionId: hashId(`${this.root}\0${requestId}`),
          preparedAt: new Date().toISOString(),
          baselineOnly: this.state.latest === null,
          before: restoredBefore ?? window.before,
          capture,
          completeness: capture.gaps.length === ended.capture.gaps.length ? ended.completeness : "degraded",
          reconciliationRequired: ended.reconciliationRequired || capture.gaps.length !== ended.capture.gaps.length,
        };
        this.state = {
          ...this.state,
          preparedAt: Object.fromEntries(Object.entries({ ...this.state.preparedAt, [requestId]: result.preparedAt }).slice(-1024)),
          pending: { ...this.state.pending, [requestId]: serializeResult(result) },
        };
        await writeState(this.statePath, this.state);
        return result;
      });
    });
  }

  async ack(requestId: string, transactionId: string): Promise<void> {
    if (!requestId || !transactionId) throw new Error("requestId and transactionId are required");
    await this.serialized(async () => {
      await withLock(this.lockPath, async () => {
        const loaded = await readState(this.statePath);
        this.state = loaded.state;
        this.stateNeedsRecovery ||= !loaded.valid;
        const expected = hashId(`${this.root}\0${requestId}`);
        if (transactionId !== expected) throw new Error("observation transaction mismatch");
        const pending = this.state.pending[requestId];
        if (pending && pending.transactionId !== transactionId) throw new Error("observation transaction mismatch");
        const latest = pending ? pending.result.capture : this.state.latest;
        const committed = this.state.committed.includes(requestId)
          ? this.state.committed
          : [...this.state.committed, requestId].slice(-1024);
        const pendingState = { ...this.state.pending };
        delete pendingState[requestId];
        this.state = {
          version: 1,
          committed,
          preparedAt: Object.fromEntries(Object.entries(this.state.preparedAt).slice(-1024)),
          latest,
          pending: pendingState,
        };
        this.stateNeedsRecovery = false;
        await writeState(this.statePath, this.state);
      });
    });
  }

  async stop(): Promise<void> {
    await this.serialized(async () => { await this.boundary.dispose(); this.restored = false; });
  }

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

export function deterministicObservationDrainId(context: ObservationContext, operationId: string): string {
  return `obs_${hashId(`${context.workspaceId}\0${context.worktreeId}\0${operationId}`).slice(0, 32)}`;
}

/** Serve drain/ack requests over a local-only newline-delimited JSON socket. */
export async function startObservationSidecarServer(root: string, options: ObservationSidecarOptions = {}): Promise<ObservationSidecarServer> {
  const key = resolve(root);
  const running = servers.get(key);
  if (running) return running;
  const sidecar = await startObservationSidecar(key, options);
  const address = socketPath(key);
  const authSecretPath = tokenPath(key);
  const authToken = randomBytes(32).toString("hex");
  await mkdir(dirname(authSecretPath), { recursive: true });
  await writeFile(authSecretPath, authToken, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(authSecretPath, 0o600).catch(() => undefined);
  }
  const proxy: ObservationSidecarServer = { address, close: async () => undefined };
  for (let attempt = 0; ; attempt += 1) {
    if (await sidecarServerResponds(address, authToken)) {
      servers.set(key, proxy);
      return proxy;
    }
    const server: Server = createServer((socket) => handleSocket(socket, sidecar, authToken));
    try {
      await new Promise<void>((resolveServer, reject) => {
        server.once("error", reject);
        server.listen(address, () => { server.removeListener("error", reject); resolveServer(); });
      });
      const service: ObservationSidecarServer = {
        address,
        async close() {
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
          if (process.platform !== "win32") await unlink(address).catch(() => undefined);
          servers.delete(key);
          await unlink(authSecretPath).catch(() => undefined);
          await stopObservationSidecar(key);
        },
      };
      servers.set(key, service);
      return service;
    } catch (error) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose())).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 1) throw error;
      if (await sidecarServerResponds(address, authToken)) {
        servers.set(key, proxy);
        return proxy;
      }
      // A dead Unix socket can survive a crashed sidecar. Re-probe after EADDRINUSE so a peer
      // that won the SessionStart race is never unlinked after its listener becomes live.
      if (process.platform !== "win32") await unlink(address).catch(() => undefined);
    }
  }
}

async function sidecarServerResponds(address: string, authToken?: string): Promise<boolean> {
  try {
    await new ObservationSidecarServerClient(address, undefined, 500, authToken).ping();
    return true;
  } catch {
    return false;
  }
}

async function handleSocket(socket: Socket, sidecar: ObservationSidecar, authToken?: string): Promise<void> {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      void handleMessage(line, sidecar, socket, authToken);
    }
  });
}

async function handleMessage(line: string, sidecar: ObservationSidecar, socket: Socket, authToken?: string): Promise<void> {
  try {
    const message = JSON.parse(line) as { op: string; token?: string; requestId?: string; transactionId?: string; context?: ObservationContext };
    if (authToken !== undefined && message.token !== authToken) {
      socket.write(JSON.stringify({ ok: false, error: "unauthorized observation request" }) + "\n");
      return;
    }
    if (message.op === "ping") {
      socket.write('{"ok":true}\n');
    } else if (message.op === "drain" && message.requestId && message.context) {
      const result = await sidecar.drain(message.requestId, message.context);
      socket.write(`${JSON.stringify({ ok: true, result: serializeResult(result) })}\n`);
    } else if (message.op === "ack" && message.requestId && message.transactionId) {
      await sidecar.ack(message.requestId, message.transactionId);
      socket.write('{"ok":true}\n');
    } else {
      socket.write('{"ok":false,"error":"invalid observation request"}\n');
    }
  } catch (error) {
    socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "observation request failed" })}\n`);
  }
}

async function readAuthToken(root: string): Promise<string | undefined> {
  try {
    const token = (await readFile(tokenPath(root), "utf8")).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export async function connectObservationSidecar(root: string): Promise<ObservationSidecarServerClient> {
  const address = socketPath(root);
  const token = await readAuthToken(root);
  return new ObservationSidecarServerClient(address, undefined, 5_000, token);
}

export async function ensureObservationSidecar(root: string, options: ObservationSidecarOptions = {}): Promise<ObservationSidecarServerClient> {
  const key = resolve(root);
  const client = await connectObservationSidecar(key);
  try {
    await client.ping();
  } catch {
    if (!servers.has(key)) {
      const entrypoint = fileURLToPath(new URL("./sidecar-bin.js", import.meta.url));
      try {
        await access(entrypoint);
        spawn(process.execPath, [entrypoint, key], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch {
        // Source-only execution has no durable detached process. Fail open; callers retain the
        // legacy capture path instead of keeping a hook alive with an in-process watcher.
        throw new Error("observation sidecar entrypoint unavailable");
      }
    }
    let connected = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await client.ping(); connected = true; break; } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 20)); }
    }
    if (!connected) throw new Error("observation sidecar could not be started");
  }
  return client;
}

export class ObservationSidecarServerClient {
  constructor(readonly address: string, private readonly local?: ObservationSidecar, private readonly requestTimeoutMs = 5_000, private readonly token?: string) {}

  drain(requestId: string, context: ObservationContext): Promise<ObservationDrainResult> {
    if (this.local) return this.local.drain(requestId, context);
    return this.request({ op: "drain", requestId, context }).then((result) => deserializeResult(result as PersistedResult));
  }

  ack(requestId: string, transactionId: string): Promise<void> {
    if (this.local) return this.local.ack(requestId, transactionId);
    return this.request({ op: "ack", requestId, transactionId }).then(() => undefined);
  }

  ping(): Promise<void> { return this.local ? Promise.resolve() : this.request({ op: "ping" }, 500).then(() => undefined); }

  private request(message: object, timeoutMs = 0): Promise<unknown> {
    const effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : this.requestTimeoutMs;
    return new Promise((resolveResponse, reject) => {
      const socket = createConnection(this.address);
      let buffer = "";
      const finish = (error?: Error, value?: unknown) => error ? reject(error) : resolveResponse(value);
      socket.setEncoding("utf8");
      if (effectiveTimeoutMs > 0) socket.setTimeout(effectiveTimeoutMs, () => socket.destroy(new Error("observation request timed out")));
      socket.once("error", finish);
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        socket.end();
        try {
          const response = JSON.parse(buffer.slice(0, end)) as { ok: boolean; result?: unknown; error?: string };
          if (!response.ok) finish(new Error(response.error ?? "observation request failed"));
          else finish(undefined, response.result);
        } catch (error) { finish(error instanceof Error ? error : new Error("invalid observation response")); }
      });
      const payload = this.token ? { ...message, token: this.token } : message;
      socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    });
  }
}

export async function startObservationSidecar(root: string, options: ObservationSidecarOptions = {}): Promise<ObservationSidecar> {
  const key = resolve(root);
  const existing = instances.get(key);
  if (existing) return existing;
  const sidecar = await new ObservationSidecar(key, options).start();
  instances.set(key, sidecar);
  return sidecar;
}

export async function requestObservationDrain(requestId: string, context: ObservationContext): Promise<ObservationDrainResult> {
  return (await ensureObservationSidecar(context.workspaceRoot)).drain(requestId, context);
}

export async function ackObservationDrain(requestId: string, transactionId: string, workspaceRoot?: string): Promise<void> {
  if (workspaceRoot) {
    await (await ensureObservationSidecar(workspaceRoot)).ack(requestId, transactionId);
    return;
  }
  for (const sidecar of instances.values()) {
    try { await sidecar.ack(requestId, transactionId); return; } catch { /* try next sidecar */ }
  }
  throw new Error("observation sidecar not found");
}

export async function stopObservationSidecar(workspaceRoot?: string): Promise<void> {
  if (workspaceRoot) {
    const key = resolve(workspaceRoot);
    const sidecar = instances.get(key);
    if (sidecar) { await sidecar.stop(); instances.delete(key); }
    return;
  }
  await Promise.all([...instances].map(async ([key, sidecar]) => { await sidecar.stop(); instances.delete(key); }));
}
