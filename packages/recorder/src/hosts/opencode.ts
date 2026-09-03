import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { NormalizedTool } from "../tool-mapping.js";
import { GIT_COMMIT } from "./claude-code.js";
import type { HostAdapter, HostCheck, HostRecord } from "./types.js";

/**
 * OpenCode's built-in tool names are lowercase (evidenced by the Task 2 captures in
 * test/fixtures/opencode). Shell tools stay opaque with the shared `git commit`
 * promotion; the file tools key on the captured `filePath` argument; the search
 * tools read without mutating, scoped by their optional `path` argument when one
 * is given. Anything unrecognized maps to `other` and stays opaque.
 */
const HOST_TOOLS: Readonly<Record<string, NormalizedTool>> = {
  bash: { toolName: "run_shell", pathProperty: null, opaque: true },
  edit: { toolName: "edit_file", pathProperty: "filePath", opaque: false },
  write: { toolName: "edit_file", pathProperty: "filePath", opaque: false },
  read: { toolName: "read_file", pathProperty: "filePath", opaque: false },
  grep: { toolName: "read_file", pathProperty: "path", opaque: false },
  glob: { toolName: "read_file", pathProperty: "path", opaque: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function normalizeOpencodeTool(hostToolName: string, command: string | null): NormalizedTool {
  const mapped = HOST_TOOLS[hostToolName];
  if (mapped === undefined) {
    return { toolName: "other", pathProperty: null, opaque: true };
  }
  if (mapped.toolName === "run_shell" && command !== null && GIT_COMMIT.test(command)) {
    return { ...mapped, toolName: "git_commit" };
  }
  return mapped;
}

/**
 * Parses an OpenCode plugin envelope in the documented `tool.execute.after` shape:
 * `{ type, tool, sessionID, callID, status, input, output }` - exactly what the Task 2
 * captures carry. An envelope that instead names its tool `tool_name` belongs to the
 * Claude Code adapter, so it is refused here to keep the two parsers disjoint; so is
 * anything missing a non-empty `tool` or `sessionID`, without which the call could not
 * be attributed at all.
 */
export function parseOpencodeEnvelope(envelope: unknown): HostRecord | null {
  if (!isRecord(envelope)) return null;
  if (nonEmptyString(envelope["tool_name"]) !== null) return null;
  const hostToolName = nonEmptyString(envelope["tool"]);
  const sessionId = nonEmptyString(envelope["sessionID"]);
  if (hostToolName === null || sessionId === null) return null;
  return {
    stage: "post",
    sessionId,
    hostToolName,
    input: envelope["input"],
    response: envelope["output"],
    delegateId: nonEmptyString(envelope["callID"]),
    // No capture shows a delegate or subagent identifier on an OpenCode call, so both
    // stay unset rather than guessed from fields no envelope has been seen to carry.
    delegateType: null,
    subagentId: null,
    // Only an explicit failure signal is read as one, mirroring how the Claude response
    // fields are read; every other status value stays unreported.
    ...(envelope["status"] === "error" ? { errored: true } : {}),
  };
}

/**
 * Renders a parsed record in the Claude hook field names so it can travel the same journal
 * and redaction path as every other payload. The host's own tool name and argument keys are
 * kept verbatim (`edit`, `filePath`) - mapping them onto the closed vocabulary is the per-
 * host tool table's job at ingest, keyed by provenance. The error signal survives as the
 * Claude-shaped `is_error` flag; the output body does not survive redaction anyway.
 */
export function translateOpencodeRecord(record: HostRecord): Record<string, unknown> {
  const response = isRecord(record.response) ? record.response : {};
  return {
    session_id: record.sessionId,
    hook_event_name: "PostToolUse",
    tool_name: record.hostToolName,
    ...(record.delegateId !== null ? { tool_use_id: record.delegateId } : {}),
    tool_input: isRecord(record.input) ? record.input : {},
    ...(record.errored === true ? { tool_response: { ...response, is_error: true } } : { tool_response: response }),
  };
}

function onPath(command: string): boolean {
  const entries = (process.env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== "");
  const extensions = process.platform === "win32"
    ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((value) => value !== "")
    : [];
  return entries.some((entry) =>
    existsSync(join(entry, command)) || extensions.some((ext) => existsSync(join(entry, command + ext))));
}

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

export const opencodeAdapter: HostAdapter = {
  id: "opencode",
  displayName: "OpenCode",
  tier: "observed",
  parse: parseOpencodeEnvelope,
  check(worktreeRoot: string): HostCheck[] {
    const pluginPath = join(worktreeRoot, ".opencode", "plugins", "patchmesh.mjs");
    if (!existsSync(pluginPath)) {
      return [{
        name: "opencode",
        status: "ok",
        detail: "OpenCode plugin not installed (optional; install with: patchmesh init --host opencode)",
      }];
    }
    try {
      const source = readFileSync(pluginPath, "utf8");
      const reference = /const RECORDER_BIN = "([^"\r\n]+)"/u.exec(source)?.[1];
      const bare = reference !== undefined && !reference.includes("/") && !reference.includes("\\");
      const resolves = reference !== undefined
        && (isAbsolute(reference)
          ? existsSync(reference)
          : !bare
            ? existsSync(join(worktreeRoot, reference))
            : onPath(reference));
      if (reference === undefined) {
        return [{
          name: "opencode",
          status: "warn",
          detail: "the OpenCode plugin is installed but names no recorder binary this doctor can check",
        }];
      }
      if (bare && resolvesOnlyThroughCmdShim(reference)) {
        return [{
          name: "opencode",
          status: "warn",
          detail: "the OpenCode plugin names a bare recorder command that Windows resolves only through a .cmd shim,"
            + " which Node refuses to spawn without a shell, so OpenCode records nothing here",
          fix: "install the recorder where its real binary resolves, then reinstall with: patchmesh init --host opencode --force",
        }];
      }
      return [resolves
        ? { name: "opencode", status: "ok" as const, detail: `OpenCode plugin installed at ${join(".opencode", "plugins", "patchmesh.mjs")}` }
        : {
          name: "opencode",
          status: "warn" as const,
          detail: "the OpenCode plugin is installed but the recorder binary it names is not here, so OpenCode records nothing",
          fix: "reinstall with: patchmesh init --host opencode --force",
        }];
    } catch {
      return [{
        name: "opencode",
        status: "warn",
        detail: "OpenCode plugin exists but could not be read",
      }];
    }
  },
};
