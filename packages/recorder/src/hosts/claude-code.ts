import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { NormalizedTool } from "../tool-mapping.js";
import type { HostAdapter, HostCheck, HostRecord } from "./types.js";

/**
 * Host tool names carry no coordination meaning on their own, so each is mapped onto the
 * closed protocol vocabulary. Anything unrecognized maps to `other` and stays opaque:
 * an unknown tool must never be silently treated as a read or a write.
 */
const HOST_TOOLS: Readonly<Record<string, NormalizedTool>> = {
  Read: { toolName: "read_file", pathProperty: "file_path", opaque: false },
  NotebookRead: { toolName: "read_file", pathProperty: "notebook_path", opaque: false },
  Write: { toolName: "edit_file", pathProperty: "file_path", opaque: false },
  Edit: { toolName: "edit_file", pathProperty: "file_path", opaque: false },
  MultiEdit: { toolName: "edit_file", pathProperty: "file_path", opaque: false },
  NotebookEdit: { toolName: "edit_file", pathProperty: "notebook_path", opaque: false },
  // Delegation is recorded as itself, not as an unrecognized call: the spawn is the edge
  // that links a parent's stream to the subagent's, so a detector must be able to find it
  // without matching on host tool names. It stays opaque because what the subagent will
  // touch is unknowable at spawn time - that is what its own recorded calls are for.
  // Claude Code names this tool `Agent`; `Task` is kept for hosts and older builds that use
  // that name for the same operation.
  Agent: { toolName: "spawn_subagent", pathProperty: null, opaque: true },
  Task: { toolName: "spawn_subagent", pathProperty: null, opaque: true },
  Bash: { toolName: "run_shell", pathProperty: null, opaque: true },
  BashOutput: { toolName: "run_shell", pathProperty: null, opaque: true },
  KillShell: { toolName: "run_shell", pathProperty: null, opaque: true },
};

/** A shell command whose effect is a commit, recognized only in its unambiguous form. Shared with the other adapters that map shell tools. */
export const GIT_COMMIT = /^\s*git\s+(?:-[^\s]+\s+|--[^\s]+(?:=[^\s]+)?\s+)*commit\b/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The host events the recorder is wired to, in the order they matter. */
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

/**
 * Whether a command resolves on the PATH, including platform-specific extensions on Windows.
 */
function onPath(command: string): boolean {
  const entries = (process.env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== "");
  const extensions = process.platform === "win32"
    ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((value) => value !== "")
    : [];
  return entries.some((entry) =>
    existsSync(join(entry, command)) || extensions.some((ext) => existsSync(join(entry, command + ext))));
}

/**
 * Whether a bare command name reaches PATH only through a `.cmd`/`.bat` shim.
 *
 * The gap this names: `onPath` answers "the name is there", but the hook spawns bare names
 * with `shell: false`, and Node >=18 refuses to spawn `.cmd`/`.bat` shims outright (EINVAL).
 * On Windows an npm-linked `patchmesh-record` is exactly such a shim, so doctor saying "ok"
 * here would bless an install that cannot record.
 */
function resolvesOnlyThroughCmdShim(command: string): boolean {
  if (process.platform !== "win32") return false;
  const entries = (process.env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== "");
  const native = entries.some((entry) =>
    existsSync(join(entry, command)) || existsSync(join(entry, `${command}.exe`)));
  if (native) return false;
  const shims = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((value) => value !== "" && value.toLowerCase() !== ".exe");
  return entries.some((entry) => shims.some((ext) => existsSync(join(entry, command + ext))));
}

/**
 * Whether this hook command is one PatchMesh installed.
 *
 * Identified by the binary it runs, not by the path it sits at.
 */
function ownsCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.replaceAll("\\", "/");
  return [
    "recorder/dist/bin.js",
    "recorder/dist/ingest-bin.js",
    "gateway/dist/session-start-bin.js",
    "patchmesh-record",
    "patchmesh-ingest",
    "patchmesh-session-start",
  ].some((binary) => normalized.includes(binary));
}

/** Host-expanded variables this can substitute itself, and what the host substitutes. */
function expandHostVariables(value: string, worktreeRoot: string): string {
  return value.replaceAll(/\$\{?CLAUDE_PROJECT_DIR\}?/gu, worktreeRoot);
}

type HookTarget = "ok" | "missing" | "unknown";

/**
 * Does an installed hook command actually run anything on this machine?
 *
 * Three answers: "ok" (resolves), "missing" (definitively absent), "unknown" (host-expanded).
 */
function resolveHookTarget(command: string, worktreeRoot: string): HookTarget {
  const quoted = /"([^"]+)"/u.exec(command);
  if (quoted !== null) {
    const expanded = expandHostVariables(quoted[1]!, worktreeRoot);
    if (expanded.includes("$")) return "unknown";
    return existsSync(join(worktreeRoot, expanded)) || existsSync(expanded) ? "ok" : "missing";
  }
  const bare = expandHostVariables(command.trim(), worktreeRoot).split(/\s+/u)[0] ?? "";
  if (bare === "") return "unknown";
  if (bare.includes("$")) return "unknown";
  return onPath(bare) ? "ok" : "missing";
}

export function normalizeClaudeTool(hostToolName: string, command: string | null): NormalizedTool {
  const mapped = HOST_TOOLS[hostToolName];
  if (mapped === undefined) {
    return { toolName: "other", pathProperty: null, opaque: true };
  }
  if (mapped.toolName === "run_shell" && command !== null && GIT_COMMIT.test(command)) {
    return { ...mapped, toolName: "git_commit" };
  }
  return mapped;
}

export function recognizesClaudeHostTool(hostToolName: string): boolean {
  return Object.hasOwn(HOST_TOOLS, hostToolName);
}

/**
 * Reads exactly the fields today's `HookPayload` relies on from a Claude Code `PostToolUse`
 * envelope. An envelope whose `tool_name` is not a non-empty string is not one this adapter
 * can own - returning null lets the caller decide what an unclaimed envelope means rather
 * than recording a half-understood call.
 *
 * `hook_event_name` is deliberately not required: the redactor journals it only when the host
 * sends it, so older journalled entries reach ingest without it and must keep ingesting.
 */
export function parseClaudeEnvelope(envelope: unknown): HostRecord | null {
  if (!isRecord(envelope)) return null;
  const rawToolName = envelope["tool_name"];
  const hostToolName = typeof rawToolName === "string" ? rawToolName.trim() : "";
  if (hostToolName === "") return null;
  return {
    stage: "post",
    sessionId: typeof envelope["session_id"] === "string" ? envelope["session_id"] : "",
    hostToolName,
    input: envelope["tool_input"],
    response: envelope["tool_response"],
    delegateId: stringOrNull(envelope["tool_use_id"]),
    delegateType: stringOrNull(envelope["agent_type"]),
    subagentId: stringOrNull(envelope["agent_id"]),
  };
}

export const claudeCodeAdapter: HostAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  tier: "observed",
  parse: parseClaudeEnvelope,
  check(worktreeRoot: string): HostCheck[] {
    const settingsPath = join(worktreeRoot, ".claude", "settings.local.json");
    if (!existsSync(settingsPath)) {
      return [{
        name: "claude-code",
        status: "ok",
        detail: "Claude Code hooks not installed (primary host; install with: patchmesh init)",
      }];
    }
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      const hooks = typeof raw["hooks"] === "object" && raw["hooks"] !== null ? raw["hooks"] : {};

      // Extract installed hook commands keyed by event, only counting hooks PatchMesh owns.
      const installed = new Map<string, string>();
      for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          if (!isRecord(group) || !Array.isArray(group["hooks"])) continue;
          for (const hook of group["hooks"]) {
            if (isRecord(hook) && ownsCommand(hook["command"])) {
              installed.set(event, String(hook["command"]));
            }
          }
        }
      }

      if (installed.size === 0) {
        return [{
          name: "claude-code",
          status: "warn",
          detail: ".claude/settings.local.json exists but has no PatchMesh hooks",
          fix: "run: patchmesh init",
        }];
      }

      // Check that all required events are present.
      const missing = HOOK_EVENTS.filter((event) => !installed.has(event));
      const presence: HostCheck = missing.length === 0
        ? { name: "claude-code", status: "ok", detail: `all ${HOOK_EVENTS.length} hooks installed` }
        : {
          name: "claude-code",
          status: "warn",
          detail: `${installed.size} of ${HOOK_EVENTS.length} hooks installed; missing ${missing.join(", ")}`,
          fix: "run: patchmesh init",
        };

      // Verify that hook commands actually resolve on this machine.
      const targets = [...installed.entries()].map(
        ([event, command]) => [event, resolveHookTarget(command, worktreeRoot)] as const,
      );
      const broken = targets.filter(([, target]) => target === "missing");
      if (broken.length > 0) {
        return [presence, {
          name: "claude-code",
          status: "fail",
          detail: `${broken.length} hook command(s) do not resolve here: ${broken.map(([event]) => event).join(", ")}`,
          fix: "reinstall (npm install -g patchmesh) and re-run: patchmesh init --force",
        }];
      }

      // Detect .cmd shim issues on Windows: bare command names that reach PATH only through
      // a .cmd shim are not spawnable by Node without a shell.
      for (const [event, command] of installed) {
        const bare = expandHostVariables(command.trim(), worktreeRoot).split(/\s+/u)[0] ?? "";
        if (bare !== "" && !bare.includes("$") && onPath(bare) && resolvesOnlyThroughCmdShim(bare)) {
          return [presence, {
            name: "claude-code",
            status: "warn",
            detail: `hook command "${bare}" resolves only through a .cmd shim, which Node refuses to spawn without a shell`,
            fix: "reinstall (npm install -g patchmesh) and re-run: patchmesh init --force",
          }];
        }
      }

      const unverified = targets.filter(([, target]) => target === "unknown");
      if (unverified.length > 0 && unverified.length === targets.length) {
        return [presence, {
          name: "claude-code",
          status: "ok",
          detail: "hook commands are resolved by the host, so their targets were not checked here",
        }];
      }

      return [presence];
    } catch {
      return [{
        name: "claude-code",
        status: "warn",
        detail: ".claude/settings.local.json exists but could not be read",
      }];
    }
  },
};
