import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { readFile, readlink, readdir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Source } from "@patchmesh/protocol";
import { normalizeLogicalPath } from "./paths.js";
import { sanitizeDiagnostic } from "./redaction.js";
import type {
  ObservationBoundary,
  ObservationCapture,
  ObservationContext,
  ObservationGap,
  ObservationSnapshot,
  ObservedFileState,
} from "./types.js";

const execFile = promisify(execFileCallback);

export interface NodeObservationOptions {
  readonly source: Source;
}

interface GitMetadata {
  readonly commonDirectory: string | null;
  readonly administrativeDirectory: string | null;
  readonly revision: string | null;
  readonly gaps: readonly ObservationGap[];
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gap(kind: ObservationGap["kind"], scope: string, reason: string): ObservationGap {
  return { kind, scope, reason: sanitizeDiagnostic(reason) };
}

async function gitValue(root: string, ...args: string[]): Promise<string | null> {
  try {
    const result = await execFile("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function captureGitMetadata(root: string): Promise<GitMetadata> {
  const commonDirectoryValue = await gitValue(root, "rev-parse", "--git-common-dir");
  const administrativeDirectoryValue = await gitValue(root, "rev-parse", "--git-dir");
  const revision = await gitValue(root, "rev-parse", "HEAD");
  const commonDirectory = commonDirectoryValue ? resolve(root, commonDirectoryValue) : null;
  const administrativeDirectory = administrativeDirectoryValue
    ? resolve(root, administrativeDirectoryValue)
    : null;
  const gaps: ObservationGap[] = [];
  if (commonDirectory === null || administrativeDirectory === null || revision === null) {
    gaps.push(gap("unverified", "git", "Git repository metadata is unavailable"));
  }
  return { commonDirectory, administrativeDirectory, revision, gaps };
}

async function gitBlobHashes(root: string, paths: readonly string[]): Promise<ReadonlyMap<string, string> | null> {
  if (paths.length === 0) return new Map();
  if (paths.some((path) => path.includes("\n") || path.includes("\r"))) return null;

  return new Promise((resolveHashes) => {
    const child = spawn("git", ["hash-object", "--stdin-paths"], {
      cwd: root,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => resolveHashes(null));
    child.once("close", (code) => {
      if (code !== 0) {
        resolveHashes(null);
        return;
      }
      const hashes = stdout.trim().split(/\r?\n/);
      if (hashes.length !== paths.length || hashes.some((hash) => hash.length === 0)) {
        resolveHashes(null);
        return;
      }
      resolveHashes(new Map(paths.map((path, index) => [path, hashes[index]!])));
    });
    child.stdin.end(`${paths.join("\n")}\n`);
  });
}

function toLogicalPath(root: string, absolutePath: string): string {
  const relativePath = relative(root, absolutePath).split(sep).join("/");
  return normalizeLogicalPath(relativePath);
}

async function captureFiles(root: string, canReadGitBlobs: boolean): Promise<{
  readonly files: ReadonlyMap<string, ObservedFileState>;
  readonly gaps: readonly ObservationGap[];
}> {
  const files = new Map<string, ObservedFileState>();
  const gaps: ObservationGap[] = [];
  const regularFiles: Array<{ readonly absolutePath: string; readonly relativePath: string; readonly logicalPath: string }> = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      gaps.push(gap("unverified", "filesystem", "A workspace directory could not be read"));
      return;
    }

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (relativePath === ".git" || relativePath.startsWith(".git/")) continue;

      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      let logicalPath: string;
      try {
        logicalPath = toLogicalPath(root, absolutePath);
      } catch {
        gaps.push(gap("unverified", "filesystem", "A path is outside the logical workspace contract"));
        continue;
      }

      if (entry.isSymbolicLink()) {
        try {
          const target = await readlink(absolutePath);
          files.set(logicalPath, {
            contentHash: sha256(`symlink:${target}`),
            gitBlob: null,
            fileKind: "symlink",
          });
        } catch {
          gaps.push(gap("unverified", logicalPath, "A symbolic link target could not be observed"));
        }
        continue;
      }

      if (!entry.isFile()) {
        gaps.push(gap("unverified", logicalPath, "A workspace entry has an unsupported file type"));
        continue;
      }
      regularFiles.push({ absolutePath, relativePath, logicalPath });
    }
  }

  await visit(root);
  const blobHashes = canReadGitBlobs ? await gitBlobHashes(root, regularFiles.map((file) => file.relativePath)) : null;
  const fallbackBlobs = canReadGitBlobs && blobHashes === null
    ? await Promise.all(regularFiles.map((file) => gitValue(root, "hash-object", "--", file.relativePath)))
    : null;
  const concurrency = 32;
  let nextFile = 0;
  const fileStates: Array<ObservedFileState | null> = Array.from({ length: regularFiles.length }, () => null);
  const workers = Array.from({ length: Math.min(concurrency, regularFiles.length) }, async () => {
    while (nextFile < regularFiles.length) {
      const index = nextFile++;
      const file = regularFiles[index]!;
      try {
        fileStates[index] = {
          contentHash: sha256(await readFile(file.absolutePath)),
          gitBlob: blobHashes?.get(file.relativePath) ?? fallbackBlobs?.[index] ?? null,
          fileKind: "file",
        };
      } catch {
        // Preserve traversal order when publishing gaps below.
      }
    }
  });
  await Promise.all(workers);
  for (let index = 0; index < regularFiles.length; index += 1) {
    const file = regularFiles[index]!;
    const state = fileStates[index];
    if (state) files.set(file.logicalPath, state);
    else gaps.push(gap("unverified", file.logicalPath, "A file content hash could not be computed"));
  }
  return { files, gaps };
}

export class NodeObservationBoundary implements ObservationBoundary {
  readonly source: Source;

  constructor(options: NodeObservationOptions) {
    this.source = options.source;
  }

  async captureBefore(context: ObservationContext): Promise<ObservationCapture> {
    return this.capture(context, false);
  }

  async captureAfter(context: ObservationContext): Promise<ObservationCapture> {
    return this.capture(context, true);
  }

  private async capture(context: ObservationContext, afterExecution: boolean): Promise<ObservationCapture> {
    const root = resolve(context.workspaceRoot);
    const git = await captureGitMetadata(root);
    const files = await captureFiles(root, git.commonDirectory !== null && git.administrativeDirectory !== null);
    const snapshot: ObservationSnapshot = {
      repository: {
        commonDirectory: git.commonDirectory,
        revision: git.revision,
      },
      worktree: {
        administrativeDirectory: git.administrativeDirectory,
      },
      files: files.files,
    };
    return {
      snapshot,
      gaps: [
        ...git.gaps,
        ...files.gaps,
        ...(afterExecution
          ? [gap(
              "unverified",
              "tool.effects",
              "snapshot observation verifies final state but cannot prove each effect originated from the intercepted operation",
            )]
          : []),
      ],
      outOfBandChanges: [],
    };
  }
}
