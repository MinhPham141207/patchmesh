#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { findWorktreeRoot } from "./identity.js";
import { appendJournalEntry, journalPathFor } from "./journal.js";
import { redactHookPayload } from "./redact.js";

/**
 * Hook entry point, on the agent's critical path.
 *
 * It imports only `./identity.js`, `./journal.js`, and `./redact.js`, none of which pull
 * anything beyond Node builtins. Importing `@patchmesh/protocol` or `@patchmesh/storage` here would add
 * roughly 400ms of Ajv import and schema compilation to every single tool call; that work
 * belongs in `patchmesh-ingest`, which pays it once. Keep this module's import graph flat.
 */

const LEDGER_DIRECTORY = ".patchmesh";
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

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
    process.stderr.write(`patchmesh-record: ${message}\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Always exits 0. This process runs inside the user's tool-call path, so it must never be
 * able to fail the call it is observing: a recorder that can break the agent gets
 * uninstalled after one incident. Failures surface only under PATCHMESH_RECORDER_DEBUG.
 */
export async function main(): Promise<number> {
  try {
    const raw = await readStdin();
    if (raw.trim() === "") {
      debug("empty hook payload");
      return 0;
    }
    const payload: unknown = JSON.parse(raw);
    const cwd = isRecord(payload) && typeof payload["cwd"] === "string" ? payload["cwd"] : process.cwd();
    const worktreeRoot = findWorktreeRoot(cwd);
    if (worktreeRoot === null) {
      debug("no git worktree found for hook cwd");
      return 0;
    }
    // Redaction happens before the first disk write, not at ingest: anything written raw
    // has already leaked, and the journal is a plain file that survives until a session ends.
    const safe = redactHookPayload(payload);
    if (safe === null) {
      debug("hook payload was not an object");
      return 0;
    }
    appendJournalEntry(journalPathFor(worktreeRoot, LEDGER_DIRECTORY), safe, new Date().toISOString());
    debug(`journalled to ${join(worktreeRoot, LEDGER_DIRECTORY)}`);
    return 0;
  } catch (error) {
    debug(error instanceof Error ? error.message : "unknown recording failure");
    return 0;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
