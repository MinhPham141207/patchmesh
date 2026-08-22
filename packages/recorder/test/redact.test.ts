import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sanitizeDiagnostic } from "patchmesh-observation";
import { SqliteEventStore } from "patchmesh-storage";
import { appendJournalEntry, ingestJournal, journalPathFor, redactHookPayload, redactText } from "../src/index.js";

const SESSION = "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";

function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-redact-"));
  mkdirSync(join(root, ".git"));
  return root;
}

/** A payload shaped like a real host hook, carrying everything that must not reach disk. */
function secretBearingPayload(): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_use_id: "toolu_abc",
    permission_mode: "bypassPermissions",
    tool_input: {
      file_path: "src/config.ts",
      command: 'curl -H "Authorization: Bearer sk-live-SUPERSECRET" https://api.example.com?token=abc123',
      content: "const API_KEY = 'sk-live-INSIDE-FILE-CONTENT';",
      old_string: "password = 'hunter2'",
      new_string: "password = 'hunter3'",
      prompt: "here is the full text of an internal document",
    },
    tool_response: {
      exit_code: 0,
      stdout: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG",
      file: { content: "every byte of the edited file" },
    },
  };
}

test("the journal keeps only whitelisted fields, never file or response bodies", () => {
  const safe = redactHookPayload(secretBearingPayload())!;
  const serialized = JSON.stringify(safe);

  for (const leaked of [
    "sk-live-INSIDE-FILE-CONTENT",
    "hunter2",
    "hunter3",
    "internal document",
    "wJalrXUtnFEMI",
    "every byte of the edited file",
  ]) {
    assert.ok(!serialized.includes(leaked), `payload leaked ${leaked}`);
  }

  const input = safe["tool_input"] as Record<string, unknown>;
  assert.equal(input["file_path"], "src/config.ts", "the resource path is what the ledger needs");
  assert.ok(!("content" in input));
  assert.ok(!("old_string" in input));
  assert.ok(!("new_string" in input));
  assert.ok(!("prompt" in input));

  // A response is reduced to the outcome signal alone - no key names, no bodies.
  assert.deepEqual(safe["tool_response"], { exit_code: 0, is_error: false });
});

test("credentials inside a whitelisted command are redacted", () => {
  const safe = redactHookPayload(secretBearingPayload())!;
  const command = (safe["tool_input"] as Record<string, unknown>)["command"] as string;
  assert.ok(!command.includes("sk-live-SUPERSECRET"), "bearer token survived");
  assert.ok(!command.includes("abc123"), "query-string token survived");
  assert.ok(command.includes("<redacted>"));
  assert.ok(command.startsWith("curl"), "the shape of the command is still legible");
});

test("recorder redaction stays in step with the shared sanitizer", () => {
  // The hot path cannot import patchmesh-observation, so the patterns are duplicated. This
  // pins the copies together: a pattern added on one side and not the other fails here.
  const corpus = [
    "Bearer abcdef123456",
    "authorization: Bearer xyz",
    "api_key=SUPERSECRET",
    "API-KEY: 'quoted secret'",
    'password="hunter2"',
    "https://x.test/a?access_token=zzz&b=1",
    "client_secret = 9f8e7d",
    "private-key: -----BEGIN",
    "nothing sensitive at all",
    "token:short",
  ];
  for (const value of corpus) {
    assert.equal(redactText(value), sanitizeDiagnostic(value), `diverged on: ${value}`);
  }
});

test("a non-object payload is refused rather than journalled as a guess", () => {
  assert.equal(redactHookPayload("just a string"), null);
  assert.equal(redactHookPayload(null), null);
  assert.equal(redactHookPayload([1, 2, 3]), null);
});

test("the hook binary writes no secret to the journal", () => {
  const root = temporaryWorktree();
  try {
    // The binary resolves the worktree from the payload's own cwd, as the host reports it.
    execFileSync("node", [join(process.cwd(), "dist", "bin.js")], {
      cwd: root,
      input: JSON.stringify({ ...secretBearingPayload(), cwd: root }),
      encoding: "utf8",
    });

    const journal = readFileSync(journalPathFor(root, ".patchmesh"), "utf8");
    for (const leaked of ["sk-live-SUPERSECRET", "sk-live-INSIDE-FILE-CONTENT", "hunter2", "wJalrXUtnFEMI"]) {
      assert.ok(!journal.includes(leaked), `journal on disk leaked ${leaked}`);
    }
    // The call itself is still recorded: redaction is not suppression.
    assert.ok(journal.includes("src/config.ts"));
    assert.ok(journal.includes("toolu_abc"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claim abandoned by a crashed ingest is adopted by the next run", () => {
  const root = temporaryWorktree();
  try {
    const journalPath = journalPathFor(root, ".patchmesh");
    const ledgerPath = join(root, ".patchmesh", "ledger.db");

    // A previous ingest renamed the journal aside and died before draining it.
    appendJournalEntry(
      journalPath,
      { session_id: SESSION, tool_name: "Read", tool_input: { file_path: "src/a.ts" }, tool_response: {} },
      "2026-08-21T10:00:00.000Z",
    );
    const orphan = `${journalPath}.9999.1.processing`;
    writeFileSync(orphan, readFileSync(journalPath, "utf8"), "utf8");
    rmSync(journalPath, { force: true });
    // Age it past the window that protects a healthy in-progress drain.
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(orphan, old, old);

    const result = ingestJournal({ worktreeRoot: root, journalPath, ledgerPath });
    assert.equal(result.ingested, 1, "the abandoned claim must not be lost forever");

    const store = SqliteEventStore.open(ledgerPath);
    try {
      assert.equal(store.read().length, 2);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claim a healthy ingest may still be draining is left alone", () => {
  const root = temporaryWorktree();
  try {
    const journalPath = journalPathFor(root, ".patchmesh");
    const ledgerPath = join(root, ".patchmesh", "ledger.db");
    mkdirSync(join(root, ".patchmesh"), { recursive: true });

    const fresh = `${journalPath}.9999.1.processing`;
    writeFileSync(fresh, `${JSON.stringify({ v: 1, at: "2026-08-21T10:00:00.000Z", payload: {} })}\n`, "utf8");

    const result = ingestJournal({ worktreeRoot: root, journalPath, ledgerPath });
    assert.equal(result.ingested, 0);
    assert.equal(readFileSync(fresh, "utf8").length > 0, true, "another ingest's claim was stolen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
