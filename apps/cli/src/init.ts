import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Wire PatchMesh into the repository the user is standing in.
 *
 * Until this existed, adopting PatchMesh meant hand-editing `.claude/settings.local.json` with
 * five hook entries and a `.mcp.json` server block, correctly, from reading the source. That is
 * not an install; it is a reconstruction. The recorder is the floor of the product, so the step
 * that turns it on has to be one command.
 *
 * Everything here is idempotent and additive. A repository is far more likely to have hooks
 * from other tools than to have none - this one is wired beside Knowl in its own checkout - so
 * merging beside what is already there is the normal case, not the edge case. An entry this
 * tool did not write is never touched, and its own entries are only replaced on `--force`.
 */

/** The key this command owns in `.mcp.json`. Hook ownership is decided by `ownsCommand`. */
const OWNED = "patchmesh";

export interface InitOptions {
  readonly worktreeRoot: string;
  readonly installHooks?: boolean;
  readonly updateGitignore?: boolean;
  /** Replace PatchMesh's own entries rather than leaving existing ones alone. */
  readonly force?: boolean;
  /** Where the recorder and gateway binaries live. Resolved from this package by default. */
  readonly packageRoot?: string;
}

export interface InitStep {
  readonly outcome: "created" | "updated" | "unchanged" | "skipped";
  readonly detail: string;
}

export interface InitResult {
  readonly steps: readonly InitStep[];
}

interface HookWiring {
  readonly event: string;
  readonly binary: string;
  readonly timeoutSeconds: number;
}

/**
 * Which host events feed the recorder, and with what.
 *
 * `PreToolUse` is what makes in-flight work visible; `PostToolUse` is the record of work done;
 * `UserPromptSubmit` is the turn boundary that gives ordinary work a task. Draining runs on
 * both `Stop` and `SessionEnd` because a session can end without stopping cleanly.
 */
const HOOKS: readonly HookWiring[] = [
  { event: "UserPromptSubmit", binary: "bin.js", timeoutSeconds: 10 },
  { event: "PreToolUse", binary: "bin.js", timeoutSeconds: 10 },
  { event: "PostToolUse", binary: "bin.js", timeoutSeconds: 10 },
  { event: "Stop", binary: "ingest-bin.js", timeoutSeconds: 60 },
  { event: "SessionEnd", binary: "ingest-bin.js", timeoutSeconds: 60 },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read JSON that may not be there, treating unreadable as absent rather than as failure. */
function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Where this build's recorder and gateway binaries are.
 *
 * Resolved from this file rather than assumed, so the same command works from a global install,
 * a workspace checkout, and a linked package. Absolute, because a hook runs with a working
 * directory the CLI does not choose.
 */
function defaultPackageRoot(): string {
  // apps/cli/dist/init.js -> repository root
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * How PatchMesh is installed, which decides what the host config may say.
 *
 * The first version of this always wrote an absolute path into the monorepo checkout. That
 * works on exactly one machine: `.mcp.json` is normally committed, so a config naming
 * `d:\patchmesh\packages\...` breaks for every teammate and every other clone. What goes in a
 * shared file has to be resolvable by whoever opens it.
 *
 * - `dependency` - installed into the repository being wired, so a path relative to its root
 *   is correct for anyone who has run an install. This is the only form safe to commit.
 * - `global` - installed on the PATH, so the bin names alone are correct and no path exists
 *   that would be right for someone else.
 * - `checkout` - running from a clone of this monorepo, where the absolute path is the only
 *   thing that resolves. Kept last because it is the developer case, not the user case.
 */
type InstallKind = "dependency" | "global" | "checkout";

interface Binaries {
  readonly kind: InstallKind;
  /** Hook command for a recorder binary, already quoted for the host config. */
  readonly hook: (binary: string) => string;
  readonly server: { readonly command: string; readonly args: readonly string[] };
}

/** Forward slashes even on Windows: these strings land in JSON other people read and commit. */
function posix(path: string): string {
  return path.replaceAll("\\", "/");
}

function resolveBinaries(worktreeRoot: string, packageRoot: string): Binaries {
  const dependencyRecorder = join(worktreeRoot, "node_modules", "@patchmesh", "recorder", "dist", "bin.js");
  if (existsSync(dependencyRecorder)) {
    return {
      kind: "dependency",
      hook: (binary) => `node "${posix(join("node_modules", "@patchmesh", "recorder", "dist", binary))}"`,
      server: { command: "node", args: [posix(join("node_modules", "@patchmesh", "gateway", "dist", "bin.js"))] },
    };
  }
  if (existsSync(join(packageRoot, "packages", "recorder", "dist", "bin.js"))) {
    return {
      kind: "checkout",
      hook: (binary) => `node "${join(packageRoot, "packages", "recorder", "dist", binary)}"`,
      server: { command: "node", args: [join(packageRoot, "packages", "gateway", "dist", "bin.js")] },
    };
  }
  // Nothing local resolves, so the install that put this CLI on the PATH put its siblings
  // there too. Bare names are what `ownsCommand` already recognizes.
  return {
    kind: "global",
    hook: (binary) => (binary === "bin.js" ? "patchmesh-record" : "patchmesh-ingest"),
    server: { command: "patchmesh-mcp", args: [] },
  };
}

/**
 * Whether this hook command is one PatchMesh installed.
 *
 * Identified by the binary it runs, not by the path it sits at. Matching the word "patchmesh"
 * anywhere in the command looked equivalent and is not: it is true only because this repository
 * happens to be named patchmesh, so a re-run in any other checkout found nothing it owned and
 * appended a second copy of every hook. Recognizing the binaries holds wherever it is installed
 * and whatever the install is called.
 */
function ownsCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.replaceAll("\\", "/");
  return RECORDER_BINARIES.some((binary) => normalized.includes(binary));
}

const RECORDER_BINARIES = [
  "recorder/dist/bin.js",
  "recorder/dist/ingest-bin.js",
  "patchmesh-record",
  "patchmesh-ingest",
] as const;

/**
 * Merge one hook entry into whatever the host config already has for that event.
 *
 * Returns whether anything changed, so a second run can honestly report "unchanged" rather
 * than rewriting the file and claiming to have installed something.
 */
function mergeHook(hooks: Record<string, unknown>, wiring: HookWiring, command: string, force: boolean): boolean {
  const existing = Array.isArray(hooks[wiring.event]) ? [...(hooks[wiring.event] as unknown[])] : [];
  const entry = {
    matcher: ".*",
    hooks: [{ type: "command", command, timeout: wiring.timeoutSeconds, statusMessage: "" }],
  };

  const ours = existing.findIndex(
    (group) =>
      isRecord(group) &&
      Array.isArray(group["hooks"]) &&
      (group["hooks"] as unknown[]).some((hook) => isRecord(hook) && ownsCommand(hook["command"])),
  );

  if (ours === -1) {
    existing.push(entry);
    hooks[wiring.event] = existing;
    return true;
  }
  if (!force) return false;
  existing[ours] = entry;
  hooks[wiring.event] = existing;
  return true;
}

function installHooks(worktreeRoot: string, binaries: Binaries, force: boolean): InitStep {
  const settingsPath = join(worktreeRoot, ".claude", "settings.local.json");
  const existed = existsSync(settingsPath);
  const settings = readJson(settingsPath);
  const hooks = isRecord(settings["hooks"]) ? { ...settings["hooks"] } : {};

  let changed = false;
  for (const wiring of HOOKS) {
    const command = binaries.hook(wiring.binary);
    if (mergeHook(hooks, wiring, command, force)) changed = true;
  }
  if (!changed) return { outcome: "unchanged", detail: "Claude Code hooks already installed" };

  writeJson(settingsPath, { ...settings, hooks });
  return {
    outcome: existed ? "updated" : "created",
    detail: `Claude Code hooks in ${relative(worktreeRoot, settingsPath)}`,
  };
}

function registerServer(worktreeRoot: string, binaries: Binaries, force: boolean): InitStep {
  const configPath = join(worktreeRoot, ".mcp.json");
  const existed = existsSync(configPath);
  const config = readJson(configPath);
  const servers = isRecord(config["mcpServers"]) ? { ...config["mcpServers"] } : {};

  if (servers[OWNED] !== undefined && !force) {
    return { outcome: "unchanged", detail: "MCP server already registered" };
  }
  servers[OWNED] = { type: "stdio", command: binaries.server.command, args: [...binaries.server.args] };
  writeJson(configPath, { ...config, mcpServers: servers });
  return { outcome: existed ? "updated" : "created", detail: `MCP server in ${relative(worktreeRoot, configPath)}` };
}

/**
 * Keep the ledger out of version control.
 *
 * `.patchmesh/` holds a SQLite database, a live journal and a filesystem snapshot - per-machine
 * state that would conflict on every pull. Appended rather than rewritten, because a
 * `.gitignore` is a file the repository owns and this command is a guest in it.
 */
function ignoreLedger(worktreeRoot: string): InitStep {
  const ignorePath = join(worktreeRoot, ".gitignore");
  const current = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  if (current.split(/\r?\n/u).some((line) => line.trim() === ".patchmesh/")) {
    return { outcome: "unchanged", detail: ".patchmesh/ already ignored" };
  }
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  writeFileSync(ignorePath, `${current}${separator}\n# PatchMesh ledger, journal and snapshot\n.patchmesh/\n`, "utf8");
  return { outcome: current === "" ? "created" : "updated", detail: ".patchmesh/ ignored" };
}

export function initializeRepository(options: InitOptions): InitResult {
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const binaries = resolveBinaries(options.worktreeRoot, packageRoot);
  const force = options.force ?? false;
  const steps: InitStep[] = [];

  steps.push(
    options.installHooks === false
      ? { outcome: "skipped", detail: "runtime hook installation skipped" }
      : installHooks(options.worktreeRoot, binaries, force),
  );
  steps.push(
    options.installHooks === false
      ? { outcome: "skipped", detail: "MCP server registration skipped" }
      : registerServer(options.worktreeRoot, binaries, force),
  );
  steps.push(
    options.updateGitignore === false
      ? { outcome: "skipped", detail: ".gitignore left alone" }
      : ignoreLedger(options.worktreeRoot),
  );

  return { steps };
}

/**
 * Report what init did.
 *
 * Says which of the steps changed something, because a second run that changes nothing and a
 * first run that wires everything must not read the same. Nothing here is a warning: an
 * already-configured repository is a success, not a no-op to apologize for.
 */
export function renderInit(result: InitResult, json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;
  const lines = result.steps.map((step) => {
    const mark = step.outcome === "skipped" ? "[--]" : step.outcome === "unchanged" ? "[==]" : "[OK]";
    return `${mark} ${step.detail}`;
  });
  const wired = result.steps.some((step) => step.outcome === "created" || step.outcome === "updated");
  lines.push(
    "",
    wired
      ? "Restart the agent session so it loads the new hooks, then work normally."
      : "Already configured. Work normally; PatchMesh is recording.",
    "",
    "Then ask what it recorded:",
    "  patchmesh events --database .patchmesh/ledger.db",
    "  patchmesh overlaps --database .patchmesh/ledger.db",
    "",
  );
  return lines.join("\n");
}
