import type { ToolName } from "patchmesh-protocol";
import { normalizeClaudeTool, recognizesClaudeHostTool } from "./hosts/claude-code.js";

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

// The Claude Code mapping now lives in hosts/claude-code.ts with the rest of that host's
// adapter; these re-exports keep every existing import site working until callers migrate.
export const normalizeTool: (hostToolName: string, command: string | null) => NormalizedTool =
  normalizeClaudeTool;

/** Tool names recognized without normalization loss, for coverage reporting. */
export function isRecognizedHostTool(hostToolName: string): boolean {
  return recognizesClaudeHostTool(hostToolName);
}
