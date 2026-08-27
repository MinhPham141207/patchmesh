import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { main } from "../src/ingest-bin.js";

const execFile = promisify(execFileCallback);

async function git(directory: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd: directory, encoding: "utf8" });
}

test("an empty ingest does not rescan or create an effects baseline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-ingest-bin-"));
  try {
    await git(directory, "init", "-b", "main");
    await git(directory, "config", "user.email", "patchmesh-tests@example.invalid");
    await git(directory, "config", "user.name", "PatchMesh Tests");
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "example.txt"), "example\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "initial");

    assert.equal(await main([directory]), 0);
    assert.equal(existsSync(join(directory, ".patchmesh", "snapshot.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
