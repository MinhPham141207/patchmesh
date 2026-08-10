import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readTraceEvents } from "./lib/trace-store.mjs";
import { validateTrace } from "./lib/summary.mjs";

async function readManifest(tracePath) {
  const traceDirectory = dirname(tracePath);
  if (basename(traceDirectory) !== "trace") return null;
  const manifestPath = join(dirname(traceDirectory), "runs", `${basename(tracePath, ".jsonl")}.manifest.json`);
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

async function validateOne(tracePath) {
  const events = await readTraceEvents(tracePath);
  return { tracePath, ...validateTrace(events, await readManifest(tracePath)) };
}

export async function main(argv = process.argv.slice(2)) {
  const all = argv[0] === "--all";
  const target = all ? argv[1] : argv[0];
  if (target === undefined) throw new Error("trace path is required");
  const paths = all ? (await readdir(target, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(target, entry.name)) : [target];
  const reports = await Promise.all(paths.map(validateOne));
  const result = { valid: reports.every((report) => report.valid), reports };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main();
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
