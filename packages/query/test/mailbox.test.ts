import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessageSentEvent, ProtocolEvent } from "patchmesh-protocol";
import { clearEventCache, SqliteEventStore } from "patchmesh-storage";
import {
  acknowledgeMessage,
  MAILBOX_DEFAULT_TTL_DAYS,
  readInbox,
  sendMail,
  undeliveredCount,
} from "../src/index.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const now = () => NOW;

function workspace(): { readonly root: string; readonly ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-mailbox-"));
  // A `.git` directory is all identity resolution needs; no real repository required.
  mkdirSync(join(root, ".git"));
  return { root, ledgerPath: join(root, ".patchmesh", "ledger.db") };
}

let sequence = 0;

function sentEvent(input: {
  readonly messageId: string;
  readonly to: { readonly kind: "agent" | "broadcast"; readonly agentId: string | null };
  readonly agentId: string;
  readonly timestamp: string;
  readonly expiresAt?: string;
}): AgentMessageSentEvent {
  sequence += 1;
  return {
    schemaVersion: 1,
    eventId: `evt_${String(sequence).padStart(32, "0")}` as AgentMessageSentEvent["eventId"],
    eventType: "agent.message.sent",
    source: {
      kind: "gateway",
      sourceId: "source_patchmesh_mailbox",
      instanceId: "11111111-1111-4111-8111-111111111111",
    },
    timestamp: input.timestamp,
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: input.agentId,
    taskId: null,
    correlationId: `corr_${String(sequence).padStart(32, "0")}`,
    causationId: null,
    sourceSequence: null,
    payload: {
      messageId: input.messageId as AgentMessageSentEvent["payload"]["messageId"],
      to: input.to,
      kind: "notice",
      subject: `subject ${input.messageId}`,
      body: `body ${input.messageId}`,
      refs: [],
      expiresAt: input.expiresAt ?? "2026-09-02T12:00:00.000Z",
    },
  };
}

function deliveredEvent(input: {
  readonly messageId: string;
  readonly agentId: string;
  readonly channel?: "session_start" | "post_tool_use" | "mcp_pull";
}): ProtocolEvent {
  sequence += 1;
  return {
    schemaVersion: 1,
    eventId: `evt_${String(sequence).padStart(32, "0")}` as never,
    eventType: "agent.message.delivered",
    source: {
      kind: "gateway",
      sourceId: "source_patchmesh_mailbox",
      instanceId: "11111111-1111-4111-8111-111111111111",
    },
    timestamp: "2026-08-26T13:00:00.000Z",
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: input.agentId,
    taskId: null,
    correlationId: `corr_${String(sequence).padStart(32, "0")}`,
    causationId: null,
    sourceSequence: null,
    payload: { messageId: input.messageId as never, channel: input.channel ?? "mcp_pull" },
  };
}

function write(path: string, events: readonly ProtocolEvent[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const store = SqliteEventStore.open(path);
  try {
    store.appendAtomic(events);
  } finally {
    store.close();
  }
}

function readSent(path: string): readonly AgentMessageSentEvent[] {
  const store = SqliteEventStore.open(path);
  try {
    return store.read({ eventTypes: ["agent.message.sent"] }) as readonly AgentMessageSentEvent[];
  } finally {
    store.close();
  }
}

function usageError(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    assert.equal((error as { name?: string }).name, "ReadServiceError");
    assert.equal((error as { code?: string }).code, "usage");
    return (error as Error).message;
  }
  throw new Error("expected the operation to throw a usage ReadServiceError");
}

test("MAILBOX_DEFAULT_TTL_DAYS is 7", () => {
  assert.equal(MAILBOX_DEFAULT_TTL_DAYS, 7);
});

test("sendMail rejects a null sender", () => {
  const { root, ledgerPath } = workspace();
  try {
    usageError(() =>
      sendMail({
        worktreeRoot: root, ledgerPath, from: null, to: "agent_bob",
        kind: "notice", subject: "hi", body: "hello", now, append: () => {},
      }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail rejects a sender that is not an agent id", () => {
  const { root, ledgerPath } = workspace();
  try {
    usageError(() =>
      sendMail({
        worktreeRoot: root, ledgerPath, from: "bob", to: "agent_bob",
        kind: "notice", subject: "hi", body: "hello", now, append: () => {},
      }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail rejects an addressee that is neither broadcast nor an agent id", () => {
  const { root, ledgerPath } = workspace();
  try {
    usageError(() =>
      sendMail({
        worktreeRoot: root, ledgerPath, from: "agent_alice", to: "everyone",
        kind: "notice", subject: "hi", body: "hello", now, append: () => {},
      }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail rejects an unknown kind", () => {
  const { root, ledgerPath } = workspace();
  try {
    usageError(() =>
      sendMail({
        worktreeRoot: root, ledgerPath, from: "agent_alice", to: "agent_bob",
        kind: "gossip" as never, subject: "hi", body: "hello", now, append: () => {},
      }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail rejects an empty or whitespace-only subject and one over 200 chars", () => {
  const { root, ledgerPath } = workspace();
  try {
    const options = {
      worktreeRoot: root, ledgerPath, from: "agent_alice", to: "agent_bob",
      kind: "notice" as const, body: "hello", now, append: () => {},
    };
    usageError(() => sendMail({ ...options, subject: "" }));
    usageError(() => sendMail({ ...options, subject: "   " }));
    usageError(() => sendMail({ ...options, subject: "x".repeat(201) }));
    sendMail({ ...options, subject: "x".repeat(200) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail stores a trimmed subject", () => {
  const { root, ledgerPath } = workspace();
  try {
    let appended: readonly ProtocolEvent[] = [];
    sendMail({
      worktreeRoot: root, ledgerPath, from: "agent_alice", to: "agent_bob",
      kind: "notice", subject: "  padded subject  ", body: "hello", now,
      append: (events) => { appended = events; },
    });
    const event = appended[0] as AgentMessageSentEvent;
    assert.equal(event.payload.subject, "padded subject");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail rejects a body over 2048 chars but accepts exactly 2048", () => {
  const { root, ledgerPath } = workspace();
  try {
    const options = {
      worktreeRoot: root, ledgerPath, from: "agent_alice", to: "agent_bob",
      kind: "notice" as const, subject: "hi", now, append: () => {},
    };
    usageError(() => sendMail({ ...options, body: "x".repeat(2049) }));
    sendMail({ ...options, body: "x".repeat(2048) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail rejects more than 20 refs, absolute refs, traversal refs, and duplicate refs", () => {
  const { root, ledgerPath } = workspace();
  try {
    const options = {
      worktreeRoot: root, ledgerPath, from: "agent_alice", to: "agent_bob",
      kind: "notice" as const, subject: "hi", body: "hello", now, append: () => {},
    };
    usageError(() => sendMail({ ...options, refs: Array.from({ length: 21 }, (_, i) => `f${i}.ts`) }));
    // Absolute paths inside the worktree normalize legally; only one that escapes it is a ref
    // the logical-path schema cannot express.
    usageError(() => sendMail({ ...options, refs: [join(root, "..", "outside-the-worktree.ts")] }));
    usageError(() => sendMail({ ...options, refs: ["../outside.ts"] }));
    usageError(() => sendMail({ ...options, refs: ["src/a.ts", "sub/../src/a.ts"] }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail normalizes refs into repository-relative form", () => {
  const { root, ledgerPath } = workspace();
  try {
    let appended: readonly ProtocolEvent[] = [];
    sendMail({
      worktreeRoot: root, ledgerPath, from: "agent_alice", to: "agent_bob",
      kind: "notice", subject: "hi", body: "hello", refs: ["sub/../src/a.ts"], now,
      append: (events) => { appended = events; },
    });
    const event = appended[0] as AgentMessageSentEvent;
    assert.deepEqual(event.payload.refs, ["src/a.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail rejects a non-ISO expiry and an expiry at or before now", () => {
  const { root, ledgerPath } = workspace();
  try {
    const options = {
      worktreeRoot: root, ledgerPath, from: "agent_alice", to: "agent_bob",
      kind: "notice" as const, subject: "hi", body: "hello", now, append: () => {},
    };
    usageError(() => sendMail({ ...options, expiresAt: "not-a-date" }));
    usageError(() => sendMail({ ...options, expiresAt: "2026-08-26T12:00:00.000Z" }));
    usageError(() => sendMail({ ...options, expiresAt: "2026-08-20T00:00:00.000Z" }));
    sendMail({ ...options, expiresAt: "2026-08-26T12:00:00.001Z" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail defaults expiry to now plus seven days", () => {
  const { root, ledgerPath } = workspace();
  try {
    let appended: readonly ProtocolEvent[] = [];
    sendMail({
      worktreeRoot: root, ledgerPath, from: "agent_alice", to: "agent_bob",
      kind: "handoff", subject: "hi", body: "hello", now,
      append: (events) => { appended = events; },
    });
    const event = appended[0] as AgentMessageSentEvent;
    assert.equal(event.payload.expiresAt, "2026-09-02T12:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail appends a well-formed agent.message.sent attributed to the sender", () => {
  const { root, ledgerPath } = workspace();
  try {
    let appended: readonly ProtocolEvent[] = [];
    const { messageId } = sendMail({
      worktreeRoot: root, ledgerPath, from: "agent_alice", to: "broadcast",
      kind: "question", subject: "who owns this", body: "saw writes here", refs: ["src/a.ts"], now,
      append: (events) => { appended = events; },
    });
    assert.match(messageId, /^msg_[0-9a-f]{32}$/);
    assert.equal(appended.length, 1);
    const event = appended[0] as AgentMessageSentEvent;
    assert.equal(event.eventType, "agent.message.sent");
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.agentId, "agent_alice");
    assert.equal(event.timestamp, "2026-08-26T12:00:00.000Z");
    assert.equal(event.taskId, null);
    assert.equal(event.payload.messageId, messageId);
    assert.deepEqual(event.payload.to, { kind: "broadcast", agentId: null });
    assert.equal(event.payload.kind, "question");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMail without an injected append writes to the ledger itself", () => {
  const { root, ledgerPath } = workspace();
  try {
    const { messageId } = sendMail({
      worktreeRoot: root, ledgerPath, from: "agent_alice", to: "agent_bob",
      kind: "notice", subject: "hi", body: "hello", now,
    });
    const sent = readSent(ledgerPath);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.payload.messageId, messageId);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox shows direct-addressed mail to the requesting agent", () => {
  const { root, ledgerPath } = workspace();
  try {
    write(ledgerPath, [
      sentEvent({ messageId: "msg_" + "a".repeat(32), to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice", timestamp: "2026-08-26T10:00:00.000Z" }),
    ]);
    const result = readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", now });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.messageId, "msg_" + "a".repeat(32));
    assert.equal(result.rows[0]?.fromAgentId, "agent_alice");
    assert.equal(result.rows[0]?.broadcast, false);
    assert.equal(result.withheld, 0);
    assert.equal(result.expired, 0);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox shows broadcasts to every agent", () => {
  const { root, ledgerPath } = workspace();
  try {
    write(ledgerPath, [
      sentEvent({ messageId: "msg_" + "b".repeat(32), to: { kind: "broadcast", agentId: null }, agentId: "agent_alice", timestamp: "2026-08-26T10:00:00.000Z" }),
    ]);
    for (const agent of ["agent_bob", "agent_carol"]) {
      const result = readInbox({ worktreeRoot: root, ledgerPath, agent, now });
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]?.broadcast, true);
    }
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox hides mail addressed to a different agent", () => {
  const { root, ledgerPath } = workspace();
  try {
    write(ledgerPath, [
      sentEvent({ messageId: "msg_" + "c".repeat(32), to: { kind: "agent", agentId: "agent_carol" }, agentId: "agent_alice", timestamp: "2026-08-26T10:00:00.000Z" }),
    ]);
    const result = readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", now });
    assert.deepEqual(result, { rows: [], withheld: 0, expired: 0 });
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox hides expired mail but counts it", () => {
  const { root, ledgerPath } = workspace();
  try {
    write(ledgerPath, [
      sentEvent({
        messageId: "msg_" + "d".repeat(32),
        to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice",
        timestamp: "2026-08-20T10:00:00.000Z", expiresAt: "2026-08-26T11:59:59.999Z",
      }),
    ]);
    const result = readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", now });
    assert.deepEqual(result.rows, []);
    assert.equal(result.expired, 1);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox hides mail already delivered to self unless includeDelivered", () => {
  const { root, ledgerPath } = workspace();
  try {
    const messageId = "msg_" + "e".repeat(32);
    write(ledgerPath, [
      sentEvent({ messageId, to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice", timestamp: "2026-08-26T10:00:00.000Z" }),
      deliveredEvent({ messageId, agentId: "agent_bob" }),
    ]);
    const hidden = readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", now });
    assert.deepEqual(hidden.rows, []);
    assert.equal(hidden.expired, 0);
    const shown = readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", includeDelivered: true, now });
    assert.equal(shown.rows.length, 1);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox keeps mail delivered to a different agent visible to me", () => {
  const { root, ledgerPath } = workspace();
  try {
    const broadcastId = "msg_" + "f".repeat(32);
    const directId = "msg_" + "1".repeat(32);
    write(ledgerPath, [
      sentEvent({ messageId: broadcastId, to: { kind: "broadcast", agentId: null }, agentId: "agent_alice", timestamp: "2026-08-26T10:00:00.000Z" }),
      sentEvent({ messageId: directId, to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice", timestamp: "2026-08-26T10:01:00.000Z" }),
      deliveredEvent({ messageId: broadcastId, agentId: "agent_carol" }),
      deliveredEvent({ messageId: directId, agentId: "agent_carol" }),
    ]);
    const result = readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", now });
    assert.deepEqual(result.rows.map((row) => row.messageId), [directId, broadcastId]);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox returns rows newest first capped at twenty with a withheld count", () => {
  const { root, ledgerPath } = workspace();
  try {
    const events: ProtocolEvent[] = [];
    for (let index = 0; index < 23; index += 1) {
      events.push(sentEvent({
        messageId: `msg_${String(index).padStart(32, "0")}`,
        to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice",
        timestamp: `2026-08-26T10:${String(index).padStart(2, "0")}:00.000Z`,
      }));
    }
    write(ledgerPath, events);
    const result = readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", now });
    assert.equal(result.rows.length, 20);
    assert.equal(result.withheld, 3);
    assert.equal(result.rows[0]?.messageId, `msg_${"0".repeat(30)}22`);
    const times = result.rows.map((row) => row.sentAt);
    assert.deepEqual(times, [...times].sort().reverse());
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox honours an explicit lower limit", () => {
  const { root, ledgerPath } = workspace();
  try {
    const events: ProtocolEvent[] = [];
    for (let index = 0; index < 5; index += 1) {
      events.push(sentEvent({
        messageId: `msg_${String(index).padStart(32, "0")}`,
        to: { kind: "broadcast", agentId: null }, agentId: "agent_alice",
        timestamp: `2026-08-26T10:${String(index).padStart(2, "0")}:00.000Z`,
      }));
    }
    write(ledgerPath, events);
    const result = readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", limit: 2, now });
    assert.equal(result.rows.length, 2);
    assert.equal(result.withheld, 3);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox honours an explicit limit above the default cap instead of clamping it", () => {
  const { root, ledgerPath } = workspace();
  try {
    const events: ProtocolEvent[] = [];
    for (let index = 0; index < 25; index += 1) {
      events.push(sentEvent({
        messageId: `msg_${String(index).padStart(32, "0")}`,
        to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice",
        timestamp: `2026-08-26T10:${String(index).padStart(2, "0")}:00.000Z`,
      }));
    }
    write(ledgerPath, events);
    const raised = readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", limit: 25, now });
    assert.equal(raised.rows.length, 25);
    assert.equal(raised.withheld, 0);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox rejects a non-positive limit", () => {
  const { root, ledgerPath } = workspace();
  try {
    usageError(() => readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", limit: 0, now }));
    usageError(() => readInbox({ worktreeRoot: root, ledgerPath, agent: "agent_bob", limit: -1, now }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInbox fails soft on an unreadable ledger", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "patchmesh-mailbox-")), "absent", "ledger.db");
  try {
    const result = readInbox({ worktreeRoot: missing, ledgerPath: missing, agent: "agent_bob", now });
    assert.deepEqual(result, { rows: [], withheld: 0, expired: 0 });
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
});

test("acknowledgeMessage appends an acknowledged event caused by the sent event", () => {
  const { root, ledgerPath } = workspace();
  try {
    const sent = sentEvent({
      messageId: "msg_" + "2".repeat(32),
      to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice",
      timestamp: "2026-08-26T10:00:00.000Z",
    });
    write(ledgerPath, [sent]);
    let appended: readonly ProtocolEvent[] = [];
    const result = acknowledgeMessage({
      worktreeRoot: root, ledgerPath, byAgentId: "agent_bob", messageId: sent.payload.messageId,
      disposition: "accepted", note: "taking it", now, append: (events) => { appended = events; },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(appended.length, 1);
    const event = appended[0];
    assert.equal(event?.eventType, "agent.message.acknowledged");
    assert.equal(event?.agentId, "agent_bob");
    assert.equal(event?.causationId, sent.eventId);
    assert.deepEqual(event?.payload, {
      messageId: sent.payload.messageId, disposition: "accepted", note: "taking it",
    });
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledgeMessage defaults the note to null and read disposition works twice", () => {
  const { root, ledgerPath } = workspace();
  try {
    const messageId = "msg_" + "3".repeat(32);
    write(ledgerPath, [
      sentEvent({ messageId, to: { kind: "broadcast", agentId: null }, agentId: "agent_alice", timestamp: "2026-08-26T10:00:00.000Z" }),
    ]);
    const appended: ProtocolEvent[] = [];
    const first = acknowledgeMessage({
      worktreeRoot: root, ledgerPath, byAgentId: "agent_bob", messageId,
      disposition: "read", now, append: (events) => { appended.push(...events); },
    });
    const second = acknowledgeMessage({
      worktreeRoot: root, ledgerPath, byAgentId: "agent_bob", messageId,
      disposition: "declined", now, append: (events) => { appended.push(...events); },
    });
    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true });
    assert.equal(appended.length, 2);
    assert.deepEqual(appended[0]?.payload, { messageId, disposition: "read", note: null });
    assert.deepEqual(appended[1]?.payload, { messageId, disposition: "declined", note: null });
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledgeMessage reports an unknown message", () => {
  const { root, ledgerPath } = workspace();
  try {
    // An empty but readable ledger: an unreadable one is an unavailable error, not a
    // "message not found" answer.
    write(ledgerPath, []);
    const result = acknowledgeMessage({
      worktreeRoot: root, ledgerPath, byAgentId: "agent_bob",
      messageId: "msg_" + "4".repeat(32), disposition: "read", now, append: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledgeMessage refuses an expired message and over-long notes", () => {
  const { root, ledgerPath } = workspace();
  try {
    const messageId = "msg_" + "5".repeat(32);
    write(ledgerPath, [
      sentEvent({
        messageId, to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice",
        timestamp: "2026-08-20T10:00:00.000Z", expiresAt: "2026-08-21T10:00:00.000Z",
      }),
    ]);
    const result = acknowledgeMessage({
      worktreeRoot: root, ledgerPath, byAgentId: "agent_bob", messageId,
      disposition: "accepted", now, append: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /expired/);
    usageError(() => acknowledgeMessage({
      worktreeRoot: root, ledgerPath, byAgentId: "agent_bob", messageId: "msg_" + "6".repeat(32),
      disposition: "read", note: "x".repeat(513), now, append: () => {},
    }));
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledgeMessage validates ids and dispositions", () => {
  const { root, ledgerPath } = workspace();
  try {
    const options = {
      worktreeRoot: root, ledgerPath, byAgentId: "bob",
      messageId: "msg_" + "7".repeat(32), disposition: "read" as const, now, append: () => {},
    };
    usageError(() => acknowledgeMessage(options));
    usageError(() => acknowledgeMessage({ ...options, byAgentId: "agent_bob", messageId: "not-a-message-id" }));
    usageError(() =>
      acknowledgeMessage({ ...options, byAgentId: "agent_bob", disposition: "maybe" as never }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("undeliveredCount counts unexpired messages with no delivery of any recipient", () => {
  const { root, ledgerPath } = workspace();
  try {
    const undelivered = "msg_" + "8".repeat(32);
    const delivered = "msg_" + "9".repeat(32);
    const expired = "msg_" + "a1".repeat(16);
    write(ledgerPath, [
      sentEvent({ messageId: undelivered, to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice", timestamp: "2026-08-26T10:00:00.000Z" }),
      sentEvent({ messageId: delivered, to: { kind: "broadcast", agentId: null }, agentId: "agent_alice", timestamp: "2026-08-26T10:01:00.000Z" }),
      sentEvent({
        messageId: expired, to: { kind: "agent", agentId: "agent_bob" }, agentId: "agent_alice",
        timestamp: "2026-08-20T10:00:00.000Z", expiresAt: "2026-08-21T10:00:00.000Z",
      }),
      deliveredEvent({ messageId: delivered, agentId: "agent_carol" }),
    ]);
    assert.equal(undeliveredCount(ledgerPath, now), 1);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("undeliveredCount fails soft to zero on an unreadable ledger", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "patchmesh-mailbox-")), "absent", "ledger.db");
  try {
    assert.equal(undeliveredCount(missing, now), 0);
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
});
