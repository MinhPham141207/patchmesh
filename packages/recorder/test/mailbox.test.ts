import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanupDeliveredMarkers, findPendingMail, isDelivered, recordMailDelivery, tryMailboxDelivery } from "../src/bin.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "patchmesh-mailbox-"));
}

function createLedger(dir: string): string {
  const patchmeshDir = join(dir, ".patchmesh");
  mkdirSync(patchmeshDir, { recursive: true });
  const ledgerPath = join(patchmeshDir, "ledger.db");
  const db = new DatabaseSync(ledgerPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      insertion_position INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      content_digest TEXT NOT NULL,
      canonical_event BLOB NOT NULL,
      schema_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_instance_id TEXT NOT NULL,
      source_sequence INTEGER,
      timestamp TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      agent_id TEXT,
      task_id TEXT,
      correlation_id TEXT NOT NULL,
      causation_id TEXT
    );
  `);
  db.close();
  return ledgerPath;
}

function insertMessage(
  ledgerPath: string,
  messageId: string,
  to: Record<string, unknown>,
  from: string,
  subject: string,
  body: string,
  expiresAt: string,
): void {
  const db = new DatabaseSync(ledgerPath, { open: true, readOnly: false } as never);
  const event = {
    schemaVersion: 1,
    eventId: messageId,
    eventType: "agent.message.sent",
    source: { kind: "gateway", sourceId: "source_patchmesh_mail", instanceId: "00000000-0000-5000-8000-000000000001" },
    timestamp: new Date().toISOString(),
    repositoryId: "repo_00000000-0000-4000-8000-000000000001",
    workspaceId: "ws_00000000-0000-5000-8000-000000000002",
    worktreeId: "wt_00000000-0000-5000-8000-000000000003",
    agentId: null,
    taskId: null,
    correlationId: "corr_00000000000000000000000000000001",
    causationId: null,
    sourceSequence: null,
    payload: { messageId, to, from, subject, body, refs: [], expiresAt },
  };
  db.prepare(`
    INSERT INTO events (event_id, content_digest, canonical_event, schema_version, event_type,
      source_kind, source_id, source_instance_id, source_sequence, timestamp,
      repository_id, workspace_id, worktree_id, agent_id, task_id,
      correlation_id, causation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    messageId,
    `digest_${messageId}`,
    Buffer.from(JSON.stringify(event), "utf8"),
    1,
    "agent.message.sent",
    "gateway",
    "source_patchmesh_mail",
    "00000000-0000-5000-8000-000000000001",
    null,
    new Date().toISOString(),
    "repo_00000000-0000-4000-8000-000000000001",
    "ws_00000000-0000-5000-8000-000000000002",
    "wt_00000000-0000-5000-8000-000000000003",
    null,
    null,
    "corr_00000000000000000000000000000001",
    null,
  );
  db.close();
}

test("findPendingMail returns broadcast message addressed to agent", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    insertMessage(ledgerPath, "msg_aaaa", { kind: "broadcast" }, "agent_sender", "Hello", "World", expiresAt);

    const mail = findPendingMail(ledgerPath, "agent_anyone");
    assert.ok(mail !== null, "should find broadcast");
    assert.equal(mail.messageId, "msg_aaaa");
    assert.equal(mail.from, "agent_sender");
    assert.equal(mail.subject, "Hello");
    assert.equal(mail.body, "World");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPendingMail returns direct message addressed to specific agent", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    insertMessage(ledgerPath, "msg_direct", { kind: "agent", agentId: "agent_target" }, "agent_a", "Urgent", "Do this", expiresAt);

    const mail = findPendingMail(ledgerPath, "agent_target");
    assert.ok(mail !== null, "should find direct message");
    assert.equal(mail.messageId, "msg_direct");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPendingMail skips message addressed to different agent", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    insertMessage(ledgerPath, "msg_other", { kind: "agent", agentId: "agent_other" }, "agent_a", "Private", "Secret", expiresAt);

    const mail = findPendingMail(ledgerPath, "agent_target");
    assert.equal(mail, null, "should not find message for different agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPendingMail skips expired message", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    const expiresAt = new Date(Date.now() - 1_000).toISOString();
    insertMessage(ledgerPath, "msg_expired", { kind: "broadcast" }, "agent_a", "Old", "Stale", expiresAt);

    const mail = findPendingMail(ledgerPath, "agent_anyone");
    assert.equal(mail, null, "should not find expired message");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPendingMail skips already delivered message", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    insertMessage(ledgerPath, "msg_delivered", { kind: "broadcast" }, "agent_a", "Seen", "Already read", expiresAt);

    // Mark as delivered
    recordMailDelivery(ledgerPath, "msg_delivered", "agent_anyone");
    assert.ok(isDelivered(ledgerPath, "msg_delivered", "agent_anyone"), "should be delivered");

    const mail = findPendingMail(ledgerPath, "agent_anyone");
    assert.equal(mail, null, "should not find delivered message");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isDelivered returns false for undelivered message", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    assert.equal(isDelivered(ledgerPath, "msg_none", "agent_anyone"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordMailDelivery creates sidecar file", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    recordMailDelivery(ledgerPath, "msg_xyz", "agent_target");
    assert.ok(isDelivered(ledgerPath, "msg_xyz", "agent_target"), "sidecar should exist");

    const sidecarDir = join(dir, ".patchmesh", "delivered");
    const content = JSON.parse(readFileSync(join(sidecarDir, "msg_xyz.agent_target"), "utf8"));
    assert.equal(content.agentId, "agent_target");
    assert.ok(typeof content.at === "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isDelivered is agent-specific", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    recordMailDelivery(ledgerPath, "msg_abc", "agent_a");
    assert.ok(isDelivered(ledgerPath, "msg_abc", "agent_a"), "agent_a should see it");
    assert.equal(isDelivered(ledgerPath, "msg_abc", "agent_b"), false, "agent_b should not see it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryMailboxDelivery delivers at rate limit boundary", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    insertMessage(ledgerPath, "msg_rate", { kind: "broadcast" }, "agent_b", "Rate test", "Body", expiresAt);

    // tryMailboxDelivery increments a counter and only delivers every 8th call.
    // We call it 8 times; only the 8th should deliver.
    let output = "";
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      for (let i = 0; i < 8; i++) {
        output = "";
        tryMailboxDelivery(dir, ledgerPath, "agent_target");
      }
      // The 8th call should have delivered
      assert.ok(output.length > 0, "8th call should produce output");
      assert.match(output, /Rate test/u, "output should contain subject");
      assert.ok(isDelivered(ledgerPath, "msg_rate", "agent_target"), "should be marked delivered");
    } finally {
      process.stdout.write = originalWrite;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryMailboxDelivery does not deliver before rate limit", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    insertMessage(ledgerPath, "msg_norate", { kind: "broadcast" }, "agent_b", "No rate", "Body", expiresAt);

    let output = "";
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      // 7 calls should not deliver (counter starts at 0, delivers at multiples of 8)
      for (let i = 0; i < 7; i++) {
        output = "";
        tryMailboxDelivery(dir, ledgerPath, "agent_target");
      }
      assert.equal(output, "", "calls 1-7 should produce no output");
      assert.equal(isDelivered(ledgerPath, "msg_norate", "agent_target"), false, "should not be marked delivered");
    } finally {
      process.stdout.write = originalWrite;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPendingMail returns null when ledger has no messages", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = createLedger(dir);
    assert.equal(findPendingMail(ledgerPath, "agent_anyone"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPendingMail returns null when ledger file does not exist", () => {
  assert.equal(findPendingMail("/nonexistent/path/ledger.db", "agent_anyone"), null);
});

test("cleanupDeliveredMarkers removes old files", () => {
  const dir = tmpDir();
  try {
    const deliveredDir = join(dir, ".patchmesh", "delivered");
    mkdirSync(deliveredDir, { recursive: true });

    // Create two marker files
    writeFileSync(join(deliveredDir, "old_msg.agent_a"), "{}", "utf8");
    writeFileSync(join(deliveredDir, "new_msg.agent_a"), "{}", "utf8");

    // Backdate "old" by 8 days (> 7-day TTL)
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(deliveredDir, "old_msg.agent_a"), oldTime, oldTime);

    const cleaned = cleanupDeliveredMarkers(dir);
    assert.equal(cleaned, 1, "should clean 1 old file");
    assert.throws(() => readFileSync(join(deliveredDir, "old_msg.agent_a")), /ENOENT/u);
    assert.ok(readFileSync(join(deliveredDir, "new_msg.agent_a"), "utf8"), "new file should survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupDeliveredMarkers keeps files within TTL", () => {
  const dir = tmpDir();
  try {
    const deliveredDir = join(dir, ".patchmesh", "delivered");
    mkdirSync(deliveredDir, { recursive: true });
    writeFileSync(join(deliveredDir, "recent_msg.agent_a"), "{}", "utf8");

    const cleaned = cleanupDeliveredMarkers(dir);
    assert.equal(cleaned, 0, "should not clean recent files");
    assert.ok(readFileSync(join(deliveredDir, "recent_msg.agent_a"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupDeliveredMarkers returns 0 for missing directory", () => {
  assert.equal(cleanupDeliveredMarkers("/nonexistent/path"), 0);
});
