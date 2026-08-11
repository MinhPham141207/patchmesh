import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadM0GateDefinition } from "./gate-definitions.js";
import { verifyM0EvidenceWithSchema, type M0ExpectedEnvironment } from "./m0-evidence.js";
import { DEFAULT_M0_ARTIFACT_PATH } from "./m0-paths.js";

export { DEFAULT_M0_ARTIFACT_PATH } from "./m0-paths.js";

export async function verifyM0Artifact(
  path: string,
  root = process.cwd(),
  expectedCommit?: string,
  expectedEnvironment?: M0ExpectedEnvironment,
) {
  let loaded: Awaited<ReturnType<typeof loadM0GateDefinition>>;
  try {
    loaded = await loadM0GateDefinition(root);
  } catch {
    return { definitionVersion: null, definitionDigest: null, outcome: "rejected" as const, diagnostics: ["M0 workload definition could not be loaded"], workloads: [] };
  }
  const [definition, digest] = loaded;
  let evidence: unknown;
  try {
    evidence = JSON.parse(await readFile(resolve(root, path), "utf8")) as unknown;
  } catch {
    return { definitionVersion: definition.definitionVersion, definitionDigest: digest, outcome: "rejected" as const, diagnostics: ["M0 evidence artifact could not be read as JSON"], workloads: [] };
  }
  const result = await verifyM0EvidenceWithSchema(evidence, definition, digest, expectedCommit, expectedEnvironment, root);
  return { definitionVersion: definition.definitionVersion, definitionDigest: digest, ...result };
}

async function readExpectedEnvironment(path: string, root: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(root, path), "utf8")) as unknown;
  } catch {
    return null;
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const root = resolve(import.meta.dirname, "../..");
  const args = process.argv.slice(2);
  let artifact = DEFAULT_M0_ARTIFACT_PATH;
  let artifactWasSet = false;
  let expectedCommit: string | undefined;
  let environmentPath: string | undefined;
  let invalidArguments = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--commit") {
      expectedCommit = args[++index];
      if (expectedCommit === undefined || !/^[0-9a-f]{40,64}$/u.test(expectedCommit)) invalidArguments = true;
    } else if (argument === "--environment") {
      environmentPath = args[++index];
      if (environmentPath === undefined) invalidArguments = true;
    } else if (argument.startsWith("-") || artifactWasSet) {
      invalidArguments = true;
    } else {
      artifact = argument;
      artifactWasSet = true;
    }
  }
  const expectedEnvironment = environmentPath === undefined ? undefined : await readExpectedEnvironment(environmentPath, root);
  if (environmentPath !== undefined && expectedEnvironment === null) invalidArguments = true;
  const result = invalidArguments
    ? { definitionVersion: null, definitionDigest: null, outcome: "rejected" as const, diagnostics: [`usage: m0-verify.ts [artifact=${DEFAULT_M0_ARTIFACT_PATH}] [--commit <revision>] [--environment <expected-environment.json>]`], workloads: [] }
    : await verifyM0Artifact(artifact, root, expectedCommit, expectedEnvironment as M0ExpectedEnvironment | undefined);
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === "rejected") process.exitCode = 2;
  else if (result.outcome === "deferred") process.exitCode = 1;
}
