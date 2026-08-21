import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { validateEventSet } from "@patchmesh/protocol";
import { SqliteEventStore } from "@patchmesh/storage";
import {
  appendJournalEntry,
  ingestJournal,
  journalPathFor,
  LEDGER_DIRECTORY,
  ledgerPathFor,
  parseJournalLine,
} from "../src/index.js";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-journal-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function payloadFor(toolName: string, toolInput: Record<string, unknown>, cwd: string): Record<string, unknown> {
  return {
    session_id: "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17",
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: {},
  };
}

function ingestInto(root: string) {
  return ingestJournal({
    worktreeRoot: root,
    journalPath: journalPathFor(root, LEDGER_DIRECTORY),
    ledgerPath: ledgerPathFor(root),
  });
}

test("journalled entries ingest into validated events preserving hook-time order", () => {
  const root = temporaryWorktree();
  try {
    const journalPath = journalPathFor(root, LEDGER_DIRECTORY);
    appendJournalEntry(journalPath, payloadFor("Read", { file_path: "src/a.ts" }, root), "2026-08-18T10:00:00.000Z");
    appendJournalEntry(journalPath, payloadFor("Edit", { file_path: "src/b.ts" }, root), "2026-08-18T10:00:01.000Z");

    const result = ingestInto(root);
    assert.equal(result.ingested, 2);
    assert.equal(result.skipped, 0);
    // The journal is consumed, so a second pass cannot double-record.
    assert.equal(existsSync(journalPath), false);
    assert.equal(ingestInto(root).ingested, 0);

    const store = SqliteEventStore.open(ledgerPathFor(root));
    try {
      const events = store.read();
      assert.equal(events.length, 4);
      assert.deepEqual(validateEventSet(events), []);
      // Timestamps come from the hook, not from ingest time.
      assert.equal(events[0]!.timestamp, "2026-08-18T10:00:00.000Z");
      assert.equal(events[2]!.timestamp, "2026-08-18T10:00:01.000Z");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a multi-line payload stays one journal line", () => {
  const root = temporaryWorktree();
  try {
    const journalPath = journalPathFor(root, LEDGER_DIRECTORY);
    appendJournalEntry(
      journalPath,
      payloadFor("Bash", { command: "echo one\necho two\necho three" }, root),
      "2026-08-18T10:00:00.000Z",
    );
    const lines = readFileSync(journalPath, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(ingestInto(root).ingested, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt journal line is skipped without losing the surrounding entries", () => {
  const root = temporaryWorktree();
  try {
    const journalPath = journalPathFor(root, LEDGER_DIRECTORY);
    appendJournalEntry(journalPath, payloadFor("Read", { file_path: "src/a.ts" }, root), "2026-08-18T10:00:00.000Z");
    writeFileSync(journalPath, `${readFileSync(journalPath, "utf8")}{ not json\n`, "utf8");
    appendJournalEntry(journalPath, payloadFor("Read", { file_path: "src/c.ts" }, root), "2026-08-18T10:00:02.000Z");

    const result = ingestInto(root);
    assert.equal(result.ingested, 2);
    assert.equal(result.skipped, 1);
    assert.equal(parseJournalLine("{ not json"), null);
    assert.equal(parseJournalLine(""), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an entry the recorder cannot represent is retained for a later version", () => {
  const root = temporaryWorktree();
  try {
    const journalPath = journalPathFor(root, LEDGER_DIRECTORY);
    // A well-formed journal line whose payload has no tool_name cannot become events.
    appendJournalEntry(journalPath, { session_id: "s", cwd: root }, "2026-08-18T10:00:00.000Z");
    const result = ingestInto(root);
    assert.equal(result.ingested, 0);
    assert.equal(result.skipped, 1);
    const rejectedFiles = readdirSync(join(root, LEDGER_DIRECTORY)).filter((name) => name.endsWith(".rejected"));
    assert.equal(rejectedFiles.length, 1);
    assert.match(readFileSync(join(root, LEDGER_DIRECTORY, rejectedFiles[0]!), "utf8"), /"session_id":"s"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ingesting an absent journal is a no-op", () => {
  const root = temporaryWorktree();
  try {
    const result = ingestInto(root);
    assert.equal(result.ingested, 0);
    assert.equal(result.ledgerPath, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hook binary journals a payload and always exits zero", () => {
  const root = temporaryWorktree();
  try {
    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify(payloadFor("Read", { file_path: "src/a.ts" }, root)),
      encoding: "utf8",
    });
    assert.equal(output, "");
    assert.equal(existsSync(journalPathFor(root, LEDGER_DIRECTORY)), true);
    assert.equal(ingestInto(root).ingested, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hook binary exits zero on malformed input and records nothing", () => {
  const root = temporaryWorktree();
  try {
    execFileSync(process.execPath, [binPath], { input: "not json at all", cwd: root, encoding: "utf8" });
    execFileSync(process.execPath, [binPath], { input: "", cwd: root, encoding: "utf8" });
    assert.equal(existsSync(journalPathFor(root, LEDGER_DIRECTORY)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hook binary's whole import graph stays free of protocol and storage", () => {
  // Loading them costs ~400ms of Ajv work per tool call, which is why ingest is separate.
  // The guard walks the transitive graph: a heavy import reached through identity.js or
  // journal.js would slow the tool path just as much as one written here directly.
  const specifiersOf = (file: string): readonly string[] =>
    [...readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)[^"']*from\s*["']([^"']+)["']/gmu)]
      .map((match) => match[1]!);

  const visited = new Set<string>();
  const external: string[] = [];
  const walk = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith(".")) {
        walk(fileURLToPath(new URL(specifier, pathToFileURL(file))));
      } else if (!specifier.startsWith("node:")) {
        external.push(specifier);
      }
    }
  };
  walk(binPath);

  assert.ok(visited.size >= 3, "expected the walk to reach identity.js and journal.js");
  assert.deepEqual(external, [], `hook path must import only node builtins, found: ${external.join(", ")}`);
});
