#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

type RecordValue = Record<string, unknown>;
export type ReadInput = () => Promise<string>;
export type InvokeRecorder = (payload: RecordValue) => number | Promise<number>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function firstString(value: RecordValue, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = nonEmptyString(value[key]);
    if (found !== null) return found;
  }
  return null;
}

function firstValue(value: RecordValue, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

export function translateCodexPayload(payload: unknown, event: string): RecordValue | null {
  if (!TOOL_EVENTS.has(event) || !isRecord(payload)) return null;
  const sessionId = firstString(payload, ["session_id", "conversation_id", "thread_id", "sessionId", "conversationId", "threadId"]);
  const toolName = firstString(payload, ["tool_name", "toolName"]);
  if (sessionId === null || toolName === null) return null;

  const translated: RecordValue = {
    session_id: sessionId,
    hook_event_name: event,
    tool_name: toolName,
    tool_input: firstValue(payload, ["tool_input", "toolInput", "input"]) ?? {},
    tool_response: firstValue(payload, ["tool_response", "toolResponse", "result", "output"]) ?? {},
    patchmesh_host: "codex",
  };
  const toolUseId = firstString(payload, ["tool_use_id", "toolUseId", "tool_call_id", "toolCallId", "call_id", "callId"]);
  if (toolUseId !== null) translated.tool_use_id = toolUseId;
  const generationId = firstString(payload, ["generation_id", "generationId"]);
  if (generationId !== null) translated.generation_id = generationId;
  const cwd = nonEmptyString(payload["cwd"]);
  if (cwd !== null) translated.cwd = cwd;
  return translated;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_PAYLOAD_BYTES) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function debug(message: string): void {
  if (process.env["PATCHMESH_RECORDER_DEBUG"] !== undefined) {
    process.stderr.write(`patchmesh-codex-relay: ${message}\n`);
  }
}

function invokeRecorder(payload: RecordValue): number {
  const builtRecorder = fileURLToPath(new URL("./bin.js", import.meta.url));
  const recorder = existsSync(builtRecorder)
    ? builtRecorder
    : fileURLToPath(new URL("../dist/bin.js", import.meta.url));
  const result = spawnSync(process.execPath, [recorder, "--host", "codex"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (result.error !== undefined) {
    debug(result.error.message);
  } else if (result.status !== 0 && result.stderr !== null) {
    debug(String(result.stderr).trim() || `recorder exited ${String(result.status)}`);
  }
  return result.status ?? 0;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  read: ReadInput = readStdin,
  invoke: InvokeRecorder = invokeRecorder,
): Promise<number> {
  try {
    const event = argv[0];
    if (event === undefined) return 0;
    const raw = await read();
    if (raw.trim() === "") return 0;
    const translated = translateCodexPayload(JSON.parse(raw), event);
    if (translated === null) return 0;
    await invoke(translated);
  } catch (error) {
    debug(error instanceof Error ? error.message : "unknown relay failure");
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
