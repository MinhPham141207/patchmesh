import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readTraceEvents } from "./lib/trace-store.mjs";
import { summarizeTrace, validateTrace } from "./lib/summary.mjs";

export async function summarizeRun({ evidenceRoot = ".evidence", runId }) {
  const root = resolve(evidenceRoot);
  const tracePath = join(root, "trace", `${runId}.jsonl`);
  const manifestPath = join(root, "runs", `${runId}.manifest.json`);
  const events = await readTraceEvents(tracePath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const validation = validateTrace(events, manifest);
  if (!validation.valid) throw new Error(`trace validation failed: ${validation.diagnostics.map((item) => item.code).join(", ")}`);
  const summary = summarizeTrace(events, manifest);
  const reportDirectory = join(root, "reports");
  const stateDirectory = join(root, ".state");
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  const temporaryPath = join(stateDirectory, `${runId}.summary.tmp.json`);
  const reportPath = join(reportDirectory, `${runId}.summary.json`);
  await writeFile(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await rename(temporaryPath, reportPath);
  return { reportPath, summary };
}

export async function main(argv = process.argv.slice(2)) {
  const runId = argv[0];
  if (runId === undefined) throw new Error("run ID is required");
  const result = await summarizeRun({ evidenceRoot: process.env.PATCHMESH_EVIDENCE_ROOT ?? ".evidence", runId });
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
