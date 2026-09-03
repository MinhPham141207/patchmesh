import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { allHostAdapters, LEDGER_DIRECTORY, ledgerPathFor, ledgerRootFor, resolveSourceHost } from "patchmesh-recorder";
import type { HostAdapter, HostCheck } from "patchmesh-recorder";
import { SqliteEventStore, projectWorkGraphCached } from "patchmesh-storage";

const INSTALLED_VERSION = readInstalledVersion();

function readInstalledVersion(): string {
  try {
    // package.json lives next to dist/ when installed globally via npm.
    const candidate = join(import.meta.dirname, "..", "package.json");
    const raw = readFileSync(candidate, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed["version"] === "string" ? parsed["version"] : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Fetch the latest version from the npm registry with a short timeout.
 *
 * Network failures are not doctor's job: this is a convenience check, not a gate.
 * A timeout or fetch error returns null, and the check stays informational.
 */
async function fetchLatestVersion(packageName: string, timeoutMs = 3000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json() as Record<string, unknown>;
    return typeof data["version"] === "string" ? data["version"] : null;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Is PatchMesh actually recording here?
 *
 * Both hook binaries always exit 0, deliberately: a recorder that can break an agent session
 * gets uninstalled. The cost of that choice is that every failure is silent and every silent
 * failure looks identical to an idle repository. A user whose hooks were never loaded, whose
 * global install is missing the recorder binary, and who simply has not worked yet all see the
 * same thing -- an empty ledger and no explanation.
 *
 * This command is the other half of failing open: nothing here changes anything, it only says
 * which of those states the repository is actually in, and what to do about it.
 *
 * Deliberately readable without a ledger. The most useful moment for this command is before
 * one exists, so it must never require, and never create, the file it is diagnosing.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What to do about it. Present only when the user has something to do. */
  readonly fix?: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** True when nothing is broken. Warnings do not clear it; failures do not survive it. */
  readonly healthy: boolean;
}

export interface DoctorOptions {
  readonly worktreeRoot: string | null;
  /** Overridden by tests so the report does not depend on the runtime running them. */
  readonly nodeVersion?: string;
  /** Overridden by tests, which cannot afford to write a real 64MiB ledger to observe a warning. */
  readonly largeLedgerBytes?: number;
  readonly now?: () => Date;
  /** Overridden by tests to avoid network calls. */
  readonly installedVersion?: string;
  /** Overridden by tests. Null means the fetch failed. */
  readonly latestVersion?: string | null;
}

/** `node:sqlite`'s DatabaseSync, which the event store is built on, does not exist before 24. */
const MINIMUM_NODE_MAJOR = 24;

/** How stale a journal has to get before it means ingest is not running, rather than mid-session. */
const JOURNAL_STALE_HOURS = 12;

/**
 * How large the ledger gets before its growth is worth saying out loud.
 *
 * Measured on this repository: 8,522 events in 19.2MB, or roughly 2.2KB an event, accruing
 * about 2,300 events a day from a single developer. Nothing prunes on its own -- `prune` has
 * existed since retention landed and has never been run -- so the only thing standing between
 * a working repository and an unbounded sidecar file is somebody noticing. 64MiB is about a
 * month at that rate: late enough that a normal week never mentions it, early enough to be a
 * note rather than a problem.
 *
 * Deliberately a `warn` that names the command rather than anything automatic. Retention
 * deletes history, and history is the product; a tool that quietly drops what it was trusted
 * to remember is worse than a large file. The choice stays with the person.
 */
const LEDGER_LARGE_BYTES = 64 * 1024 * 1024;

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function majorOf(version: string): number {
  return Number.parseInt(version.replace(/^v/u, "").split(".")[0] ?? "", 10);
}

function checkNode(version: string): DoctorCheck {
  const major = majorOf(version);
  if (Number.isNaN(major)) {
    return { name: "node", status: "warn", detail: `could not read the Node version from ${version}` };
  }
  if (major >= MINIMUM_NODE_MAJOR) return { name: "node", status: "ok", detail: `${version}` };
  return {
    name: "node",
    status: "fail",
    detail: `${version} cannot open the ledger; node:sqlite needs ${MINIMUM_NODE_MAJOR} or newer`,
    fix: `install Node ${MINIMUM_NODE_MAJOR}+ and re-run`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function checkServer(worktreeRoot: string): DoctorCheck {
  const config = readJson(join(worktreeRoot, ".mcp.json"));
  const servers = isRecord(config["mcpServers"]) ? config["mcpServers"] : {};
  if (servers["patchmesh"] === undefined) {
    return {
      name: "mcp",
      status: "warn",
      // A warning, not a failure: recording works without it. What is lost is agents being
      // able to read the ledger themselves, which is the half that pays off.
      detail: "the patchmesh MCP server is not registered, so agents cannot read the ledger",
      fix: "run: patchmesh init",
    };
  }
  return { name: "mcp", status: "ok", detail: "MCP server registered in .mcp.json" };
}

/**
 * Check a host adapter's configuration and return its diagnostic checks, prefixed with
 * the host's display name and coverage tier so the doctor output groups results per-host.
 */
function checkHostAdapter(adapter: HostAdapter, worktreeRoot: string): readonly DoctorCheck[] {
  const hostChecks: HostCheck[] = adapter.check(worktreeRoot);
  return hostChecks.map((hc: HostCheck) => ({
    ...hc,
    name: `${adapter.displayName} (${adapter.tier})`,
  }));
}

function checkGitignore(worktreeRoot: string, ledgerRoot: string): DoctorCheck {
  const path = join(ledgerRoot, ".gitignore");
  const contents = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (contents.split(/\r?\n/u).some((line) => line.trim() === `${LEDGER_DIRECTORY}/`)) {
    return { name: "gitignore", status: "ok", detail: `${LEDGER_DIRECTORY}/ is ignored` };
  }
  return {
    name: "gitignore",
    status: "warn",
    detail: `${LEDGER_DIRECTORY}/ is not ignored in ${relative(worktreeRoot, path) || ".gitignore"};`
      + " the ledger is per-machine state and will show up as changes",
    fix: "run: patchmesh init",
  };
}

interface LedgerFacts {
  readonly events: number;
  readonly latest: string | null;
}

function readLedger(path: string): LedgerFacts | null {
  // Opened only when the file is already there. Opening creates and migrates a database, and a
  // command whose job is to report that nothing has been recorded must not record anything.
  if (!existsSync(path)) return null;
  const store = SqliteEventStore.open(path);
  try {
    // Asked of SQLite rather than answered by loading the ledger, which keeps these two
    // numbers cheap: this read once loaded every event and validated each out of its
    // canonical blob, and on a 8,931-event ledger that was most of `doctor`'s six seconds,
    // growing with history. The size check below still avoids loading events; the replay
    // check that follows loads them deliberately, because validating the replay is its job.
    return { events: store.count(), latest: store.latestTimestamp() };
  } finally {
    store.close();
  }
}

function checkLedger(worktreeRoot: string, ledgerPath: string, shared: boolean, largeBytes: number): DoctorCheck {
  let facts: LedgerFacts | null;
  try {
    facts = readLedger(ledgerPath);
  } catch (error) {
    return {
      name: "ledger",
      status: "fail",
      detail: `${ledgerPath} could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  const where = shared ? `${ledgerPath} (shared by every worktree of this repository)` : ledgerPath;
  if (facts === null) {
    return {
      name: "ledger",
      status: "warn",
      // Not a failure. A configured repository nobody has worked in yet is the expected state
      // right after init, and the recorder writes the file on the first call it sees.
      detail: `no ledger at ${relative(worktreeRoot, ledgerPath) || ledgerPath} yet, so nothing has been recorded`,
      fix: "restart the agent session so the host loads the hooks, then work normally",
    };
  }
  if (facts.events === 0) {
    return { name: "ledger", status: "warn", detail: `${where} exists but holds no events` };
  }

  // Size is reported whether or not it is a problem yet, so growth is visible before it is.
  let bytes = 0;
  try {
    bytes = statSync(ledgerPath).size;
  } catch {
    // Readable a moment ago, so this is a race rather than a fault. Report without the size.
  }
  const size = bytes === 0 ? "" : `, ${humanBytes(bytes)}`;
  if (bytes >= largeBytes) {
    return {
      name: "ledger",
      status: "warn",
      detail: `${facts.events} event(s) in ${where}${size}, latest ${facts.latest}`
        + " — nothing prunes the ledger on its own",
      fix: "drop history you no longer need: patchmesh prune --older-than 30",
    };
  }
  return {
    name: "ledger",
    status: "ok",
    detail: `${facts.events} event(s) in ${where}${size}, latest ${facts.latest}`,
  };
}

function checkAttribution(ledgerPath: string): DoctorCheck {
  if (!existsSync(ledgerPath)) {
    return { name: "attribution", status: "warn", detail: "no ledger \u2014 attribution unknown" };
  }
  try {
    const store = SqliteEventStore.open(ledgerPath);
    try {
      const total = store.count();
      if (total === 0) {
        return { name: "attribution", status: "ok", detail: "0 events \u2014 nothing to attribute" };
      }
      const attributed = store.handle.prepare(
        "SELECT COUNT(*) as n FROM events WHERE task_id IS NOT NULL",
      ).get() as { n: number };
      const rate = Math.round((attributed.n / total) * 100);
      return {
        name: "attribution",
        status: rate >= 80 ? "ok" : "warn",
        detail: `${rate}% of events carry a task (${attributed.n}/${total})`,
      };
    } finally {
      store.close();
    }
  } catch {
    return { name: "attribution", status: "warn", detail: "could not read ledger" };
  }
}

/**
 * Replay the whole ledger and validate every event, which is the one check that can say the
 * history itself is intact rather than merely present.
 *
 * It costs a full replay (~1.5s at 10k events) every run, and that is accepted by spec:
 * corruption discovery is routine here, speed is not doctor's job. The counts above stay
 * cheap precisely so this check is the only thing paying for the events.
 */
function replayCheck(ledgerPath: string): DoctorCheck {
  try {
    projectWorkGraphCached(ledgerPath, { verify: true });
    return { name: "replay", status: "ok", detail: "every event validated and replayed" };
  } catch (error) {
    return {
      name: "replay",
      status: "fail",
      detail: `replay failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The journal is the live half: the hook appends to it per call, and ingest drains it into the
 * ledger when the session stops. Entries sitting in it are normal mid-session and abnormal a
 * day later, which is the difference between "working" and "the drain never runs".
 */
function checkJournal(worktreeRoot: string, now: Date): readonly DoctorCheck[] {
  const directory = join(worktreeRoot, LEDGER_DIRECTORY);
  if (!existsSync(directory)) return [];
  const journalPath = join(directory, "journal.ndjson");
  const checks: DoctorCheck[] = [];

  if (existsSync(journalPath)) {
    const pending = readFileSync(journalPath, "utf8").split("\n").filter((line) => line.trim() !== "").length;
    const ageHours = (now.getTime() - statSync(journalPath).mtimeMs) / 3_600_000;
    if (pending > 0 && ageHours > JOURNAL_STALE_HOURS) {
      checks.push({
        name: "journal",
        status: "warn",
        detail: `${pending} entr(ies) have waited ${Math.round(ageHours)}h to be ingested,`
          + " which means the Stop hook is not draining them",
        fix: "check that the Stop and SessionEnd hooks are installed: patchmesh init",
      });
    } else if (pending > 0) {
      checks.push({ name: "journal", status: "ok", detail: `${pending} entr(ies) waiting for the next drain` });
    }
  }

  let entries: readonly string[] = [];
  try {
    entries = readdirSync(directory);
  } catch {
    return checks;
  }
  const orphaned = entries.filter((entry) => entry.endsWith(".processing"));
  if (orphaned.length > 0) {
    checks.push({
      name: "journal",
      status: "warn",
      detail: `${orphaned.length} interrupted drain(s) left behind; the next ingest adopts them`,
    });
  }
  const rejected = entries.filter((entry) => entry.endsWith(".rejected"));
  if (rejected.length > 0) {
    checks.push({
      name: "journal",
      status: "warn",
      // Kept rather than dropped, by design, so this is recoverable data and worth naming.
      detail: `${rejected.length} file(s) of entries that could not be represented as events`,
      fix: `inspect ${join(LEDGER_DIRECTORY, rejected[0]!)}`,
    });
  }
  return checks;
}

function checkVersion(installed: string, latest: string | null): DoctorCheck {
  if (installed === "unknown") {
    return { name: "version", status: "ok", detail: "installed version unknown" };
  }
  if (latest === null) {
    return { name: "version", status: "ok", detail: `installed ${installed} (could not check npm for updates)` };
  }
  if (compareVersions(installed, latest) < 0) {
    return {
      name: "version",
      status: "warn",
      detail: `installed ${installed}, latest ${latest}`,
      fix: `update with: npm install -g patchmesh@latest`,
    };
  }
  return { name: "version", status: "ok", detail: `installed ${installed} (up to date)` };
}

export async function diagnose(options: DoctorOptions): Promise<DoctorReport> {
  const now = (options.now ?? (() => new Date()))();
  const checks: DoctorCheck[] = [
    checkNode(options.nodeVersion ?? process.version),
    // Named even when everything else is broken: provenance is stamped per event, so a user
    // reading the ledger needs to know which host this report's install is.
    { name: "host", status: "ok", detail: resolveSourceHost() },
  ];

  if (options.worktreeRoot === null) {
    checks.push({
      name: "repository",
      status: "fail",
      detail: "not inside a git repository, and the repository is PatchMesh's unit of identity",
      fix: "run this inside a git worktree",
    });
    return { checks, healthy: false };
  }

  const worktreeRoot = options.worktreeRoot;
  const ledgerRoot = ledgerRootFor(worktreeRoot);
  const shared = ledgerRoot !== worktreeRoot;
  checks.push({
    name: "repository",
    status: "ok",
    detail: shared
      ? `${worktreeRoot} (a linked worktree; the ledger lives in ${ledgerRoot})`
      : worktreeRoot,
  });
  checks.push(checkServer(worktreeRoot));
  // Iterate all registered host adapters and collect per-host diagnostic checks.
  for (const adapter of allHostAdapters()) {
    checks.push(...checkHostAdapter(adapter, worktreeRoot));
  }
  checks.push(checkGitignore(worktreeRoot, ledgerRoot));
  const ledgerPath = ledgerPathFor(worktreeRoot);
  checks.push(checkLedger(worktreeRoot, ledgerPath, shared, options.largeLedgerBytes ?? LEDGER_LARGE_BYTES));
  checks.push(checkAttribution(ledgerPath));
  // Only when the ledger-existence check above had something to look at: replaying a file
  // that is not there would create one, and this command never creates what it diagnoses.
  if (existsSync(ledgerPath)) checks.push(replayCheck(ledgerPath));
  checks.push(...checkJournal(worktreeRoot, now));

  // Version check: compare installed version against the latest on npm.
  // Tests inject both values; production fetches live. A failed fetch is informational only.
  const installed = options.installedVersion ?? INSTALLED_VERSION;
  const latest = options.latestVersion !== undefined
    ? options.latestVersion
    : await fetchLatestVersion("patchmesh");
  checks.push(checkVersion(installed, latest));

  return { checks, healthy: !checks.some((check) => check.status === "fail") };
}

export function renderDoctor(report: DoctorReport, json: boolean): string {
  if (json) return `${JSON.stringify(report)}\n`;
  const mark: Record<CheckStatus, string> = { ok: "[OK]", warn: "[!!]", fail: "[XX]" };
  const lines = report.checks.flatMap((check) => {
    const head = `${mark[check.status]} ${check.name}: ${check.detail}`;
    return check.fix === undefined ? [head] : [head, `       -> ${check.fix}`];
  });
  const warnings = report.checks.filter((check) => check.status === "warn").length;
  lines.push(
    "",
    report.healthy
      ? warnings === 0
        ? "PatchMesh is recording."
        : `PatchMesh is recording, with ${warnings} thing(s) worth knowing about above.`
      : "PatchMesh is not recording here. Fix the [XX] lines above.",
    "",
  );
  return lines.join("\n");
}
