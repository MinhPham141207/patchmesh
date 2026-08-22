import type { ToolName } from "patchmesh-protocol";

export interface NormalizedTool {
  /** Closed protocol vocabulary the detectors match on. */
  readonly toolName: ToolName;
  /** Property of `tool_input` naming the resource this call acts on, when there is one. */
  readonly pathProperty: string | null;
  /**
   * True when the call's effect cannot be bounded from its declared input. An opaque
   * call still records; it reports reduced coverage rather than a guessed resource.
   */
  readonly opaque: boolean;
}

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

/** A shell command whose effect is a commit, recognized only in its unambiguous form. */
const GIT_COMMIT = /^\s*git\s+(?:-[^\s]+\s+|--[^\s]+(?:=[^\s]+)?\s+)*commit\b/u;

export function normalizeTool(hostToolName: string, command: string | null): NormalizedTool {
  const mapped = HOST_TOOLS[hostToolName];
  if (mapped === undefined) {
    return { toolName: "other", pathProperty: null, opaque: true };
  }
  if (mapped.toolName === "run_shell" && command !== null && GIT_COMMIT.test(command)) {
    return { ...mapped, toolName: "git_commit" };
  }
  return mapped;
}

/** Tool names recognized without normalization loss, for coverage reporting. */
export function isRecognizedHostTool(hostToolName: string): boolean {
  return Object.hasOwn(HOST_TOOLS, hostToolName);
}
