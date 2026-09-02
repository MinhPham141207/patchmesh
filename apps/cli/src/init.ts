import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
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
  /**
   * An additional host to wire beside Claude Code. `opencode` installs a relay plugin;
   * `codex` and `generic-mcp` register MCP servers; `all` detects present hosts and
   * installs for each.
   */
  readonly host?: "opencode" | "codex" | "generic-mcp" | "claude-code" | "all";
  /** Where the recorder and gateway binaries live. Resolved from this package by default. */
  readonly packageRoot?: string;
}

export interface InitStep {
  readonly outcome: "created" | "updated" | "unchanged" | "skipped" | "warning";
  readonly detail: string;
}

export interface InitResult {
  readonly steps: readonly InitStep[];
}

/** Which package owns a hook binary. The recorder writes; the gateway is the one that reads. */
type HookPackage = "recorder" | "gateway";

interface HookWiring {
  readonly event: string;
  readonly package: HookPackage;
  readonly binary: string;
  readonly timeoutSeconds: number;
}

/**
 * Which host events feed the recorder, and with what.
 *
 * `PreToolUse` is what makes in-flight work visible; `PostToolUse` is the record of work done;
 * `UserPromptSubmit` is the turn boundary that gives ordinary work a task. Draining runs on
 * both `Stop` and `SessionEnd` because a session can end without stopping cleanly.
 *
 * `SessionStart` is the only one that reads. Every other hook here puts something into the
 * ledger, which is why PatchMesh recorded thousands of events and answered eight questions:
 * recall existed but nothing in an agent's loop ever chose to ask for it. Its timeout is the
 * longest of the per-session hooks because it pays the schema-compilation cost the recorder's
 * flat import graph avoids -- once, before the first prompt, rather than on every call. It
 * fails open like the rest. See docs/problems/PM-01.
 */
const HOOKS: readonly HookWiring[] = [
  { event: "SessionStart", package: "gateway", binary: "session-start-bin.js", timeoutSeconds: 15 },
  { event: "UserPromptSubmit", package: "recorder", binary: "bin.js", timeoutSeconds: 10 },
  { event: "PreToolUse", package: "recorder", binary: "bin.js", timeoutSeconds: 10 },
  { event: "PostToolUse", package: "recorder", binary: "bin.js", timeoutSeconds: 10 },
  { event: "Stop", package: "recorder", binary: "ingest-bin.js", timeoutSeconds: 60 },
  { event: "SessionEnd", package: "recorder", binary: "ingest-bin.js", timeoutSeconds: 60 },
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
 * - `checkout` - running from a clone of this monorepo. Written against `$CLAUDE_PROJECT_DIR`
 *   when that clone *is* the repository being wired, which is the contributor case and the
 *   only one this branch normally sees; an absolute path only when PatchMesh is being run from
 *   somewhere else to wire a different repository, where nothing repository-relative resolves.
 *   Kept last because it is the developer case, not the user case.
 */
type InstallKind = "dependency" | "global" | "checkout";

interface Binaries {
  readonly kind: InstallKind;
  /** Hook command for a binary in one of the hook-owning packages, quoted for the host config. */
  readonly hook: (owner: HookPackage, binary: string) => string;
  readonly server: { readonly command: string; readonly args: readonly string[] };
  /**
   * Where the recorder binary is, in the one spelling the OpenCode plugin can carry. Unlike a
   * Claude hook command, a plugin file is read by a runtime that expands nothing, so whatever
   * goes in has to resolve on its own - which is why the same three install kinds produce
   * three different shapes here rather than one command string.
   */
  readonly recorderBin: RecorderBinary;
}

/**
 * One of the three forms the OpenCode plugin's recorder reference can take.
 *
 * `repo-relative` is the committed form: resolved by whoever runs the plugin against the
 * repository root it sits inside, correct for every clone that has run an install or holds
 * the checkout. `absolute` is baked in at write time and only ever right on this machine.
 * `on-path` names a bare command and trusts the PATH, the same bet the global hook branch
 * makes.
 */
type RecorderBinary =
  | { readonly kind: "repo-relative"; readonly path: string }
  | { readonly kind: "absolute"; readonly path: string }
  | { readonly kind: "on-path"; readonly command: string };

/** npm package name for a hook owner, used for both dependency paths and Node resolution. */
const HOOK_PACKAGE_NAMES: Readonly<Record<HookPackage, string>> = {
  recorder: "patchmesh-recorder",
  gateway: "patchmesh-gateway",
};

/** Forward slashes even on Windows: these strings land in JSON other people read and commit. */
function posix(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Is the PatchMesh checkout inside the repository being wired?
 *
 * Decides whether a path can be written against the repository or has to name this machine.
 * `relative` returns `""` for the same directory, a `..`-prefixed path for one above, and - on
 * Windows, across drives - an absolute path it cannot express as a relative one at all.
 */
function isInsideWorktree(worktreeRoot: string, packageRoot: string): boolean {
  const rel = relative(worktreeRoot, packageRoot);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Whether a bare command name actually resolves on this machine's PATH.
 *
 * The global branch below writes bare names on the reasoning that whatever put `patchmesh` on
 * the PATH put its siblings there too. That is false for the most obvious install of all:
 * `npm install -g patchmesh` links only this package's bin, and the recorder and gateway are
 * separate packages whose bins npm never links. The config that produced was syntactically
 * fine and completely inert -- the hooks fail open and exit 0, so nothing was ever recorded
 * and nothing ever said why.
 *
 * PATH is scanned directly rather than shelling out to `where`/`which`: this runs during
 * `init` on a machine whose shell is unknown, and a missing lookup tool must not read as a
 * missing binary. PATHEXT is honoured so the `.cmd` shims npm writes on Windows are found.
 */
/** Exported for `doctor`, which reuses the same PATH test for the OpenCode plugin's bare form. */
export function onPath(command: string): boolean {
  const entries = (process.env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== "");
  const extensions = process.platform === "win32"
    ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((value) => value !== "")
    : [];
  return entries.some((entry) =>
    existsSync(join(entry, command)) || extensions.some((ext) => existsSync(join(entry, command + ext))));
}

/**
 * Where a sibling package's `dist` actually landed, according to Node's own resolution.
 *
 * npm links the bins of the package you name and never its dependencies', so `npm install -g
 * patchmesh` leaves `patchmesh-record` off the PATH while the code sits in the install
 * directory the whole time. Node can find it; the earlier code guessed a bare name instead and
 * wrote a config that recorded nothing and reported nothing.
 *
 * `import.meta.resolve` rather than `createRequire().resolve`: these packages are ESM with an
 * `exports` map offering only the `import` condition, so CJS resolution refuses them outright
 * with ERR_PACKAGE_PATH_NOT_EXPORTED. For the same reason the package's main entry is resolved
 * and its directory taken, rather than asking for the `dist/bin.js` subpath the map does not
 * expose.
 */
function siblingDist(specifier: string): string | null {
  try {
    return dirname(fileURLToPath(import.meta.resolve(specifier)));
  } catch {
    return null;
  }
}

function resolveBinaries(worktreeRoot: string, packageRoot: string): Binaries {
  const dependencyRecorder = join(worktreeRoot, "node_modules", "patchmesh-recorder", "dist", "bin.js");
  if (existsSync(dependencyRecorder)) {
    return {
      kind: "dependency",
      hook: (owner, binary) => `node "${posix(join("node_modules", HOOK_PACKAGE_NAMES[owner], "dist", binary))}"`,
      server: { command: "node", args: [posix(join("node_modules", "patchmesh-gateway", "dist", "bin.js"))] },
      recorderBin: {
        kind: "repo-relative",
        path: posix(join("node_modules", HOOK_PACKAGE_NAMES.recorder, "dist", "bin.js")),
      },
    };
  }
  if (existsSync(join(packageRoot, "packages", "recorder", "dist", "bin.js"))) {
    // Written against the repository rather than against this machine whenever the checkout
    // being wired *is* the checkout PatchMesh is running from - which is the whole contributor
    // case, and the only one that produced the bug.
    //
    // `.claude/settings.local.json` and `.mcp.json` are both tracked here, so an absolute path
    // in either is per-developer churn that breaks for every other clone. It has already been
    // removed by hand twice and come back, because only the file was fixed and the writer that
    // produces it was not.
    //
    // The portable form was always supported on the way back in: `resolveHookTarget` expands
    // `$CLAUDE_PROJECT_DIR` before checking the file, so `doctor` verifies these hooks rather
    // than reporting them `unknown` - the reader understood the spelling before the writer
    // emitted it, and the recorder hooks in that file have been in this form all along.
    //
    // The absolute path stays for the case where it really is the only thing that resolves: a
    // clone of this monorepo used to wire some *other* repository, where `$CLAUDE_PROJECT_DIR`
    // points at that repository and not at wherever PatchMesh lives.
    const inside = isInsideWorktree(worktreeRoot, packageRoot);
    const within = (...segments: readonly string[]): string => posix(join(relative(worktreeRoot, packageRoot), ...segments));
    return {
      kind: "checkout",
      hook: (owner, binary) => inside
        ? `node "$CLAUDE_PROJECT_DIR/${within("packages", owner, "dist", binary)}"`
        : `node "${join(packageRoot, "packages", owner, "dist", binary)}"`,
      server: inside
        ? { command: "node", args: [within("packages", "gateway", "dist", "bin.js")] }
        : { command: "node", args: [join(packageRoot, "packages", "gateway", "dist", "bin.js")] },
      recorderBin: inside
        ? { kind: "repo-relative", path: within("packages", "recorder", "dist", "bin.js") }
        : { kind: "absolute", path: posix(join(packageRoot, "packages", "recorder", "dist", "bin.js")) },
    };
  }
  // A global install. Bare names are preferred when the siblings really are on the PATH,
  // because that is the one form that also works for a teammate who installed the same way.
  // When they are not, the resolved path is machine specific but actually runs, which beats a
  // shareable name that does nothing. The committable form is the dependency branch above.
  const recorderDist = siblingDist("patchmesh-recorder");
  const gatewayDist = siblingDist("patchmesh-gateway");
  const distFor = (owner: HookPackage) => (owner === "recorder" ? recorderDist : gatewayDist);
  // The bin names each package publishes. A binary with no bare name here would silently
  // resolve to the wrong command, so the map is exhaustive rather than defaulted.
  const bareNames: Readonly<Record<string, string>> = {
    "bin.js": "patchmesh-record",
    "ingest-bin.js": "patchmesh-ingest",
    "session-start-bin.js": "patchmesh-session-start",
  };
  return {
    kind: "global",
    hook: (owner, binary) => {
      const bare = bareNames[binary];
      const dist = distFor(owner);
      if (bare !== undefined && onPath(bare)) return bare;
      if (dist === null) return bare ?? binary;
      return `node "${posix(join(dist, binary))}"`;
    },
    server: onPath("patchmesh-mcp") || gatewayDist === null
      ? { command: "patchmesh-mcp", args: [] }
      : { command: "node", args: [posix(join(gatewayDist, "bin.js"))] },
    // Unlike the hook branch above, a bare PATH name is the last resort here, not the
    // preference: a plugin spawns the recorder itself, and npm's `.cmd` shims are not
    // spawnable from Node without a shell - so wherever the real binary can be resolved,
    // its absolute path is baked in instead.
    recorderBin: recorderDist === null
      ? { kind: "on-path", command: "patchmesh-record" }
      : { kind: "absolute", path: posix(join(recorderDist, "bin.js")) },
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
export function ownsCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.replaceAll("\\", "/");
  return RECORDER_BINARIES.some((binary) => normalized.includes(binary));
}

/** The host events the recorder is wired to, in the order they matter. Read by `doctor`. */
export const HOOK_EVENTS: readonly string[] = HOOKS.map((wiring) => wiring.event);

/**
 * Does an installed hook command actually run anything on this machine?
 *
 * The three forms `resolveBinaries` writes fail differently, and all three fail silently. A
 * quoted path can point into a checkout that has been deleted or a global install that has
 * been upgraded out from under it; a bare name is only correct while the package that owns it
 * is still linked onto the PATH. Either way the host runs the command, gets a non-zero exit or
 * nothing at all, and the hook's fail-open contract swallows it.
 *
 * Three answers, not two. `unknown` exists because a hook command is a string the *host*
 * expands before running it, and a config this tool did not write may reference variables only
 * the host can resolve. The first version of this returned a boolean and reported a working
 * five-hook install -- 3,241 recorded events, a live journal -- as five broken commands,
 * because the commands read `$CLAUDE_PROJECT_DIR/...`. Claiming breakage that cannot be
 * demonstrated is worse than declining to check: it sends people to reinstall something that
 * was never wrong.
 *
 * A relative path is resolved against the worktree, because that is the working directory the
 * host runs hooks in and the form `init` deliberately writes for a committed config.
 */
export type HookTarget = "ok" | "missing" | "unknown";

/** Host-expanded variables this can substitute itself, and what the host substitutes. */
function expandHostVariables(value: string, worktreeRoot: string): string {
  return value.replaceAll(/\$\{?CLAUDE_PROJECT_DIR\}?/gu, worktreeRoot);
}

export function resolveHookTarget(command: string, worktreeRoot: string): HookTarget {
  const quoted = /"([^"]+)"/u.exec(command);
  if (quoted !== null) {
    const expanded = expandHostVariables(quoted[1]!, worktreeRoot);
    // Anything still holding a variable is the host's to resolve, not this command's to judge.
    if (expanded.includes("$")) return "unknown";
    return existsSync(join(worktreeRoot, expanded)) || existsSync(expanded) ? "ok" : "missing";
  }
  const bare = expandHostVariables(command.trim(), worktreeRoot).split(/\s+/u)[0] ?? "";
  if (bare === "") return "unknown";
  if (bare.includes("$")) return "unknown";
  return onPath(bare) ? "ok" : "missing";
}

/**
 * Every binary PatchMesh installs as a hook, in all the spellings `resolveBinaries` writes.
 *
 * A binary missing from this list is not recognised as ours, so a second `init` appends a
 * duplicate hook rather than reporting "unchanged" -- which is the failure this list was
 * introduced to fix. Add here whenever `HOOKS` gains an entry.
 */
const RECORDER_BINARIES = [
  "recorder/dist/bin.js",
  "recorder/dist/ingest-bin.js",
  "gateway/dist/session-start-bin.js",
  "patchmesh-record",
  "patchmesh-ingest",
  "patchmesh-session-start",
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
    const command = binaries.hook(wiring.package, wiring.binary);
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
  // Only the three fields this command actually owns are overwritten; anything else already on
  // the entry is carried through. `--force` means "replace PatchMesh's own wiring", not "discard
  // whatever else is configured here" - and a host or a user may have added keys this tool has
  // no model for. Re-running `init --force` in this repository silently dropped `"tools": ["*"]`
  // from its own entry, which is the additive rule at the top of this file being broken by the
  // one branch that rewrites rather than merges.
  const existing = isRecord(servers[OWNED]) ? servers[OWNED] : {};
  servers[OWNED] = {
    ...existing,
    type: "stdio",
    command: binaries.server.command,
    args: [...binaries.server.args],
  };
  writeJson(configPath, { ...config, mcpServers: servers });
  return { outcome: existed ? "updated" : "created", detail: `MCP server in ${relative(worktreeRoot, configPath)}` };
}

/**
 * The OpenCode relay plugin, generated verbatim into `.opencode/plugins/patchmesh.mjs`.
 *
 * Self-contained ESM whose only imports are node builtins: OpenCode loads plugins under Bun
 * as readily as under Node, so nothing beyond the standard library may be assumed. It spawns
 * rather than appends - unlike the Claude hooks, which hand the host a command string, a
 * plugin is code that has to run the recorder itself - and it swallows every error, because
 * recording may cost time but must never break a tool call.
 *
 * Only `tool.execute.after` is relayed. A `tool.execute.before` relay would journal a full
 * completion-shaped payload before the call has run, double-recording every call; the
 * recorder also drops such payloads defensively, but an installed plugin predating that fix
 * is the only thing that still needs the guard.
 *
 * The recorder reference is baked in at write time in one of the three shapes
 * `resolveBinaries` produces. A repo-relative path is resolved by the plugin itself against
 * the repository root derived from its own location (`<root>/.opencode/plugins/`), which is
 * what makes the committed form work for every clone without host variable expansion, which
 * OpenCode does not do.
 */
export function opencodePluginSource(recorder: RecorderBinary): string {
  const bin = recorder.kind === "on-path" ? recorder.command : recorder.path;
  const lines: readonly string[] = [
    "// PatchMesh relay plugin for OpenCode.",
    "// Generated by `patchmesh init --host opencode`; regenerate with --force after upgrading.",
    "// Records every tool call to the local PatchMesh ledger. Every error is swallowed on",
    "// purpose: recording may cost time, but it must never break a tool call.",
    'import { spawnSync } from "node:child_process";',
    'import { join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    `const RECORDER_BIN = ${JSON.stringify(bin)};`,
    `const RECORDER_RELATIVE = ${recorder.kind === "repo-relative" ? "true" : "false"};`,
    `const RECORDER_BARE = ${recorder.kind === "on-path" ? "true" : "false"};`,
    "",
    "// Repository root, derived from this file's own location: <root>/.opencode/plugins/",
    "// patchmesh.mjs - two segments up from the directory leaves the repository root.",
    "function repoRoot() {",
    '  return fileURLToPath(new URL("../..", import.meta.url));',
    "}",
    "",
    "function record() {",
    "  return (input) => {",
    "    try {",
    "      const bin = RECORDER_RELATIVE ? join(repoRoot(), RECORDER_BIN) : RECORDER_BIN;",
    "      // A baked path names a .js file, so it runs under this runtime's own interpreter;",
    "      // a bare name is already an executable in its own right.",
    "      const command = RECORDER_BARE ? bin : process.execPath;",
    "      const recorderArgs = RECORDER_BARE ? [] : [bin];",
    "      spawnSync(",
    "        command,",
    '        [...recorderArgs, "--host", "opencode"],',
    "        {",
    "          input: JSON.stringify(input ?? {}),",
    '          stdio: ["pipe", "ignore", "ignore"],',
    "          timeout: 10000,",
    "          shell: false,",
    "        },",
    "      );",
    "    } catch {",
    "      // Swallowed deliberately - see the header comment.",
    "    }",
    "  };",
    "}",
    "",
    "// Only the after-stage is relayed: a before-relay would record every call twice.",
    "export const PatchMeshPlugin = async () => ({",
    '  "tool.execute.after": record(),',
    "});",
    "",
  ];
  return lines.join("\n");
}

/**
 * Write the OpenCode plugin, idempotently.
 *
 * Compared byte-for-byte before writing, so a second run reports "unchanged" instead of
 * rewriting the file and claiming to have installed something. A plugin this tool did not
 * write is never touched: overwriting a hand-edited or newer plugin would silently discard
 * someone's wiring, so only `--force` replaces a differing file.
 */
function installOpencodePlugin(worktreeRoot: string, binaries: Binaries, force: boolean): InitStep {
  const pluginPath = join(worktreeRoot, ".opencode", "plugins", "patchmesh.mjs");
  const source = opencodePluginSource(binaries.recorderBin);
  const existed = existsSync(pluginPath);
  if (existed && readFileSync(pluginPath, "utf8") === source) {
    return { outcome: "unchanged", detail: "OpenCode plugin already installed" };
  }
  if (existed && !force) {
    return {
      outcome: "warning",
      detail: "an OpenCode plugin already exists with different contents; rerun with --force to replace it",
    };
  }
  mkdirSync(dirname(pluginPath), { recursive: true });
  writeFileSync(pluginPath, source, "utf8");
  return {
    outcome: existed ? "updated" : "created",
    detail: `OpenCode relay plugin in ${relative(worktreeRoot, pluginPath)}`,
  };
}

/**
 * Register the PatchMesh gateway as a Codex MCP server in `.mcp.json`.
 *
 * Codex uses MCP servers for its integrations. Without a host-specific config format,
 * the gateway is registered under a `patchmesh-codex` key so it can be distinguished from
 * the Claude Code registration. This is idempotent and additive: existing entries are
 * never removed.
 */
function installCodexHooks(worktreeRoot: string, binaries: Binaries, force: boolean): InitStep {
  const CODEX_KEY = "patchmesh-codex";
  const configPath = join(worktreeRoot, ".mcp.json");
  const existed = existsSync(configPath);
  const config = readJson(configPath);
  const servers = isRecord(config["mcpServers"]) ? { ...config["mcpServers"] } : {};

  if (servers[CODEX_KEY] !== undefined && !force) {
    return { outcome: "unchanged", detail: "Codex MCP server already registered" };
  }

  const existing = isRecord(servers[CODEX_KEY]) ? servers[CODEX_KEY] : {};
  servers[CODEX_KEY] = {
    ...existing,
    type: "stdio",
    command: binaries.server.command,
    args: [...binaries.server.args],
  };
  writeJson(configPath, { ...config, mcpServers: servers });
  return { outcome: existed ? "updated" : "created", detail: `Codex MCP server in ${relative(worktreeRoot, configPath)}` };
}

/**
 * Register the generic-mcp self-reporting tools in `.mcp.json`.
 *
 * The generic-mcp adapter is `declared` tier — participation is self-reported rather than
 * observed. The three MCP tools (`patchmesh_session_begin`, `patchmesh_checkin`,
 * `patchmesh_session_end`) let any MCP host report its own calls without requiring a
 * host-specific hook adapter. Registered under a `patchmesh-generic-mcp` key so it can
 * be distinguished from other registrations.
 */
function installGenericMcp(worktreeRoot: string, force: boolean): InitStep {
  const GENERIC_MCP_KEY = "patchmesh-generic-mcp";
  const configPath = join(worktreeRoot, ".mcp.json");
  const existed = existsSync(configPath);
  const config = readJson(configPath);
  const servers = isRecord(config["mcpServers"]) ? { ...config["mcpServers"] } : {};

  if (servers[GENERIC_MCP_KEY] !== undefined && !force) {
    return { outcome: "unchanged", detail: "Generic MCP tools already registered" };
  }

  const existing = isRecord(servers[GENERIC_MCP_KEY]) ? servers[GENERIC_MCP_KEY] : {};
  servers[GENERIC_MCP_KEY] = {
    ...existing,
    type: "stdio",
    command: "patchmesh-mcp",
    args: [],
    description: "Self-reported participation for MCP-only hosts (declared tier)",
  };
  writeJson(configPath, { ...config, mcpServers: servers });
  return { outcome: existed ? "updated" : "created", detail: `Generic MCP tools in ${relative(worktreeRoot, configPath)}` };
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
  // Only when asked for: a host this run did not name gets no step at all, so the output of
  // an ordinary `init` reads exactly as it did before hosts existed.
  if (options.host === "opencode") {
    steps.push(
      options.installHooks === false
        ? { outcome: "skipped", detail: "OpenCode plugin skipped" }
        : installOpencodePlugin(options.worktreeRoot, binaries, force),
    );
  }
  if (options.host === "codex") {
    steps.push(
      options.installHooks === false
        ? { outcome: "skipped", detail: "Codex MCP server skipped" }
        : installCodexHooks(options.worktreeRoot, binaries, force),
    );
  }
  if (options.host === "generic-mcp") {
    steps.push(
      options.installHooks === false
        ? { outcome: "skipped", detail: "Generic MCP tools skipped" }
        : installGenericMcp(options.worktreeRoot, force),
    );
  }
  if (options.host === "claude-code") {
    steps.push(
      options.installHooks === false
        ? { outcome: "skipped", detail: "Claude Code hooks skipped" }
        : installHooks(options.worktreeRoot, binaries, force),
    );
  }
  if (options.host === "all") {
    // Detect which hosts are present in the worktree and install for each.
    // Always install Claude Code hooks (default behavior).
    steps.push(
      options.installHooks === false
        ? { outcome: "skipped", detail: "Claude Code hooks skipped" }
        : installHooks(options.worktreeRoot, binaries, force),
    );
    // Detect OpenCode: look for .opencode directory
    if (existsSync(join(options.worktreeRoot, ".opencode"))) {
      steps.push(
        options.installHooks === false
          ? { outcome: "skipped", detail: "OpenCode plugin skipped" }
          : installOpencodePlugin(options.worktreeRoot, binaries, force),
      );
    }
    // Detect Codex: look for .codex directory or codex.json
    if (
      existsSync(join(options.worktreeRoot, ".codex")) ||
      existsSync(join(options.worktreeRoot, "codex.json"))
    ) {
      steps.push(
        options.installHooks === false
          ? { outcome: "skipped", detail: "Codex MCP server skipped" }
          : installCodexHooks(options.worktreeRoot, binaries, force),
      );
    }
    // Generic MCP is always present as a declared-tier participant
    steps.push(
      options.installHooks === false
        ? { outcome: "skipped", detail: "Generic MCP tools skipped" }
        : installGenericMcp(options.worktreeRoot, force),
    );
  }

  // A global install that is missing its siblings produces a config that looks correct and
  // records nothing. Say so here, where the user is standing, rather than leaving them to
  // discover an empty ledger later.
  // Only when the recorder is neither on the PATH nor resolvable from this install. Anything
  // else means a working command was written, whether bare or resolved.
  if (binaries.kind === "global" && options.installHooks !== false
    && !onPath("patchmesh-record") && siblingDist("patchmesh-recorder") === null) {
    steps.push({
      outcome: "warning",
      detail: "patchmesh-record could not be found - hooks will record nothing."
        + " Reinstall with: npm install -g patchmesh",
    });
  }

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
    const mark = step.outcome === "warning" ? "[!!]"
      : step.outcome === "skipped" ? "[--]"
      : step.outcome === "unchanged" ? "[==]"
      : "[OK]";
    return `${mark} ${step.detail}`;
  });
  const wired = result.steps.some((step) => step.outcome === "created" || step.outcome === "updated");
  const incomplete = result.steps.some((step) => step.outcome === "warning");
  lines.push(
    "",
    incomplete
      ? "Install the missing binaries above, then restart the agent session."
      : wired
        ? "Restart the agent session so it loads the new hooks, then work normally."
        : "Already configured. Work normally; PatchMesh is recording.",
    "",
    // Recap leads because it is the surface that pays off on one agent working alone, which
    // is the workflow almost every reader of this message actually has. Overlap needs two
    // agents running at once before it can say anything at all.
    "Next session, ask what the last one did:",
    "  the patchmesh_recap MCP tool, or",
    "  patchmesh agents",
    "",
    "Then what it recorded:",
    "  patchmesh events",
    "  patchmesh overlaps",
    "",
  );
  return lines.join("\n");
}
