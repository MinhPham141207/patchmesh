import { recordHookPayload } from "./lib/recorder.mjs";
import { translatePatchMeshPayload } from "./lib/patchmesh-bridge.mjs";
import { pathToFileURL } from "node:url";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    const result = { accepted: false, duplicate: false, eventId: null, tracePath: null, diagnostic: { code: "TRACE_INPUT_INVALID", message: "stdin must contain one JSON object" } };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.stderr.write(`${result.diagnostic.code}: ${result.diagnostic.message}\n`);
    return result;
  }
  const result = await recordHookPayload({ payload: translatePatchMeshPayload(payload), env: process.env });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.accepted && result.diagnostic !== null) process.stderr.write(`${result.diagnostic.code}: ${result.diagnostic.message}\n`);
  return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
