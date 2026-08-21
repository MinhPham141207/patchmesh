/**
 * Field whitelisting and secret redaction for the raw hook payload.
 *
 * This runs on the agent's critical path, so like `journal.ts` it imports nothing at all -
 * `@patchmesh/observation` owns the same secret patterns but reaching them means importing a
 * package barrel that costs the hot path more than the redaction saves. `redact.test.ts`
 * asserts the two implementations agree on a shared corpus, so the duplication cannot drift
 * silently.
 *
 * The whitelist is the primary control and the redaction is the backstop. A host payload
 * carries the full text of every file read, every command run, and every response returned;
 * none of that can be reconstructed from what survives here, so a pattern this module fails
 * to recognize still cannot leak a file's contents.
 */

const MAX_TEXT_LENGTH = 512;

/** Payload keys this build understands; anything else is reported by name as schema drift. */
const KNOWN_PAYLOAD_KEYS = new Set([
  "session_id",
  "hook_event_name",
  "tool_name",
  "tool_use_id",
  "cwd",
  "transcript_path",
  "tool_input",
  "tool_response",
  "prompt_id",
  "permission_mode",
  "effort",
  "duration_ms",
  "agent_id",
  "agent_type",
]);

const SECRET_NAME =
  "(?:api[_-]?key|access[_-]?token|auth(?:orization)?|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|credential|private[_-]?key)";

/**
 * Redact credential-shaped text. Kept byte-identical in behaviour to
 * `sanitizeDiagnostic` in `@patchmesh/observation`; change both together.
 */
export function redactText(value: string): string {
  let sanitized = value;
  sanitized = sanitized.replace(/(\bBearer\s+)[^\s]+/giu, "$1<redacted>");
  sanitized = sanitized.replace(
    new RegExp(`(${SECRET_NAME}\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&]+)`, "giu"),
    "$1<redacted>",
  );
  sanitized = sanitized.replace(new RegExp(`([?&])(${SECRET_NAME}=)[^&\\s]+`, "giu"), "$1$2<redacted>");
  return sanitized.slice(0, MAX_TEXT_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A whitelisted string field: redacted and length-bounded, or absent. */
function textField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? redactText(value) : undefined;
}

/**
 * The `tool_input` properties the recorder actually reads.
 *
 * `file_path` and `notebook_path` name the resource a call acts on; `command` decides
 * `run_shell` versus `git_commit` and describes the operation; `description` and
 * `subagent_type` name a delegated task. Everything else - `content`, `old_string`,
 * `new_string`, `prompt` - is the payload's bulk and its risk, and is dropped. A file's
 * contents are never what the ledger needed.
 */
const INPUT_TEXT_KEYS = ["file_path", "notebook_path", "command", "description", "subagent_type"] as const;

function redactToolInput(toolInput: unknown): Record<string, unknown> | undefined {
  if (!isRecord(toolInput)) return undefined;
  const safe: Record<string, unknown> = {};
  for (const key of INPUT_TEXT_KEYS) {
    const value = textField(toolInput, key);
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

/**
 * Reduce `tool_response` to the outcome signal alone.
 *
 * A response body is the largest and least predictable thing a host hands over - command
 * output, file contents, API results. The recorder only ever asked whether the call failed
 * and with what code, so only that is kept, and an error is reduced to the fact of one.
 */
function redactToolResponse(toolResponse: unknown): Record<string, unknown> | undefined {
  if (!isRecord(toolResponse)) return undefined;
  const rawExit = toolResponse["exit_code"] ?? toolResponse["exitCode"];
  const exitCode = typeof rawExit === "number" && Number.isInteger(rawExit) ? rawExit : null;
  const isError =
    toolResponse["is_error"] === true ||
    toolResponse["isError"] === true ||
    typeof toolResponse["error"] === "string";
  const safe: Record<string, unknown> = { exit_code: exitCode, is_error: isError };
  // A spawn's response names the delegate it created. This is the authoritative parent-to-
  // child edge: the same id arrives on that subagent's own calls as `agent_id`, so the two
  // streams join on a value the host declared rather than on anything inferred. Only the
  // identifiers are kept - the response also carries the subagent's full prompt and output.
  for (const key of ["agentId", "agentType"]) {
    const value = toolResponse[key];
    if (typeof value === "string") safe[key] = redactText(value);
  }
  return safe;
}

/**
 * Reduce a raw host hook payload to the whitelisted subset the recorder can represent.
 *
 * Returns null when the payload is not an object, which the caller journals as nothing at
 * all rather than guessing at a shape.
 */
export function redactHookPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;

  const safe: Record<string, unknown> = {};
  // Identity and lineage: opaque host identifiers and local paths, never user content.
  for (const key of [
    "session_id",
    "hook_event_name",
    "tool_name",
    "tool_use_id",
    "cwd",
    "transcript_path",
    // Present only on a subagent's calls: the host names the delegate that made them.
    "agent_id",
    "agent_type",
  ]) {
    const value = payload[key];
    if (typeof value === "string") safe[key] = value;
  }

  // Names only, never values. A host that starts reporting a new field - lineage, task,
  // parent call - is invisible otherwise, and this canary is exactly how `agent_id` was
  // found. It covers the hook envelope only, whose keys are the host's own fixed schema;
  // `tool_response` gets no equivalent, because its shape comes from arbitrary tools and
  // MCP servers whose field names are themselves third-party data.
  const unknownKeys = Object.keys(payload).filter((key) => !KNOWN_PAYLOAD_KEYS.has(key));
  if (unknownKeys.length > 0) safe["unknown_keys"] = unknownKeys.sort();

  const toolInput = redactToolInput(payload["tool_input"]);
  if (toolInput !== undefined) safe["tool_input"] = toolInput;
  const toolResponse = redactToolResponse(payload["tool_response"]);
  if (toolResponse !== undefined) safe["tool_response"] = toolResponse;

  return safe;
}
