import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AgentMessageDeliveredEvent,
  AgentMessageSentEvent,
  ProtocolEvent,
} from "patchmesh-protocol";
import type { ReadServices } from "patchmesh-query";
import { SqliteEventStore } from "patchmesh-storage";
import { runCli } from "../src/main.js";

/**
 * CLI surfaces over the real mailbox query layer: every test drives `runCli` against a real
 * SQLite ledger in a temporary workspace, so what passes here is what a person runs.
 */

let sequence = 0;

function workspace(): { readonly root: string; readonly ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-mailbox-cli-"));
  // A `.git` directory is all identity resolution needs; no real repository required.
  mkdirSync(join(root, ".git"));
  return { root, ledgerPath: join(root, ".patchmesh", "ledger.db") };
}

/** Unavailable services fail loudly, so a command routed away from the mailbox cannot pass. */
function unavailableServices(): ReadServices {
  const unavailable = (): never => {
    throw new Error("this command does not read the event store");
  };
  return new Proxy({} as ReadServices, { get: () => unavailable });
}

const dependencies = { services: unavailableServices() };

function sentEvent(input: {
  readonly messageId: string;
  readonly to: { readonly kind: "agent" | "broadcast"; readonly agentId: string | null };
  readonly agentId: string;
  readonly sentAt?: string;
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
    timestamp: input.sentAt ?? "2026-08-26T12:00:00.000Z",
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: input.agentId as AgentMessageSentEvent["agentId"],
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
      expiresAt: "2027-09-02T12:00:00.000Z",
    },
  };
}

function deliveredEvent(input: { readonly messageId: string; readonly agentId: string }): ProtocolEvent {
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
    agentId: input.agentId as AgentMessageDeliveredEvent["agentId"],
    taskId: null,
    correlationId: `corr_${String(sequence).padStart(32, "0")}`,
    causationId: null,
    sourceSequence: null,
    payload: { messageId: input.messageId as never, channel: "mcp_pull" },
  };
}

function seed(path: string, events: readonly ProtocolEvent[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const store = SqliteEventStore.open(path);
  try {
    store.appendAtomic(events);
  } finally {
    store.close();
  }
}

function readPayloads<T>(path: string, eventType: ProtocolEvent["eventType"]): readonly T[] {
  // A ledger that was never written is the honest empty answer, not an error.
  if (!existsSync(path)) return [];
  const store = SqliteEventStore.open(path);
  try {
    return store.read({ eventTypes: [eventType] })
      .filter((event) => event.eventType === eventType)
      .map((event) => event.payload as T);
  } finally {
    store.close();
  }
}

test("send appends a message and confirms with its id", async () => {
  const { root, ledgerPath } = workspace();
  try {
    const result = await runCli([
      "send", "--to", "agent_bee", "--kind", "handoff",
      "--subject", "take over the login fix", "--body", "branch is green, PR open",
      "--from", "agent_aye", "--database", ledgerPath,
    ], { ...dependencies, worktreeRoot: root });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /MESSAGE SENT/);
    assert.match(result.stdout, /To: agent_bee/);
    const payloads = readPayloads<{ subject: string; body: string; messageId: string }>(
      ledgerPath, "agent.message.sent",
    );
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.subject, "take over the login fix");
    assert.match(result.stdout, /Message: msg_[0-9a-f]{32}/);
    const printedId = result.stdout.match(/msg_[0-9a-f]{32}/)?.[0];
    assert.equal(payloads[0]?.messageId, printedId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a send that fails validation exits 2 and says why", async () => {
  const { root, ledgerPath } = workspace();
  try {
    const badAudience = await runCli([
      "send", "--to", "not-an-agent", "--kind", "notice",
      "--subject", "hello", "--body", "hi", "--from", "agent_aye", "--database", ledgerPath,
    ], { ...dependencies, worktreeRoot: root });
    assert.equal(badAudience.exitCode, 2);
    assert.match(badAudience.stderr, /to must be an agent_<id> or the literal "broadcast"/);

    const missingSubject = await runCli([
      "send", "--to", "agent_bee", "--kind", "notice",
      "--body", "hi", "--from", "agent_aye", "--database", ledgerPath,
    ], { ...dependencies, worktreeRoot: root });
    assert.equal(missingSubject.exitCode, 2);
    assert.match(missingSubject.stderr, /--subject/);

    // Nothing from either failed attempt may have been recorded.
    assert.equal(readPayloads(ledgerPath, "agent.message.sent").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty inbox says so in a sentence", async () => {
  const { root, ledgerPath } = workspace();
  try {
    const empty = await runCli(["inbox", "--agent", "agent_bee", "--database", ledgerPath], dependencies);
    assert.equal(empty.exitCode, 0);
    assert.match(empty.stdout, /^No messages waiting for agent_bee\.\n$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox renders bounded rows newest first and names the withheld count", async () => {
  const { root, ledgerPath } = workspace();
  try {
    const events = Array.from({ length: 22 }, (_unused, index) =>
      sentEvent({
        messageId: `msg_${String(index).padStart(32, "0")}`,
        to: { kind: "agent", agentId: "agent_bee" },
        agentId: "agent_aye",
        sentAt: `2026-08-26T12:${String(index).padStart(2, "0")}:00.000Z`,
      }));
    seed(ledgerPath, events);

    const result = await runCli(["inbox", "--agent", "agent_bee", "--database", ledgerPath], dependencies);

    assert.equal(result.exitCode, 0);
    const lines = result.stdout.trim().split("\n");
    assert.match(lines[0] ?? "", /^20 message\(s\) waiting for agent_bee$/u);
    assert.equal(lines.length, 22, "20 rows plus the withheld line");
    assert.match(lines.at(-1) ?? "", /\(\+2 more withheld\)/u);
    // Rows carry no trailing separator when refs are empty.
    assert.doesNotMatch(lines[1] ?? "", / · $/u);
    assert.match(result.stdout, /subject msg_00000000000000000000000000000021/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivered mail is hidden unless --include-delivered is given", async () => {
  const { root, ledgerPath } = workspace();
  try {
    seed(ledgerPath, [
      sentEvent({
        messageId: `msg_${"a".repeat(32)}`,
        to: { kind: "agent", agentId: "agent_bee" },
        agentId: "agent_aye",
      }),
      deliveredEvent({ messageId: `msg_${"a".repeat(32)}`, agentId: "agent_bee" }),
    ]);

    const delivered = await runCli(["inbox", "--agent", "agent_bee", "--database", ledgerPath], dependencies);
    assert.match(delivered.stdout, /^No messages waiting for agent_bee\./u);

    const included = await runCli([
      "inbox", "--agent", "agent_bee", "--include-delivered", "--database", ledgerPath,
    ], dependencies);
    assert.match(included.stdout, /1 message\(s\) waiting for agent_bee/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ack appends an acknowledgement attributed to the acknowledger", async () => {
  const { root, ledgerPath } = workspace();
  try {
    seed(ledgerPath, [
      sentEvent({
        messageId: `msg_${"b".repeat(32)}`,
        to: { kind: "agent", agentId: "agent_bee" },
        agentId: "agent_aye",
      }),
    ]);

    const result = await runCli([
      "ack", `msg_${"b".repeat(32)}`, "--accept", "--note", "taking it",
      "--from", "agent_bee", "--database", ledgerPath,
    ], { ...dependencies, worktreeRoot: root });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /MESSAGE ACKNOWLEDGED/);
    assert.match(result.stdout, /Disposition: accepted/);
    const acked = readPayloads<{ messageId: string; disposition: string; note: string | null }>(
      ledgerPath, "agent.message.acknowledged",
    );
    assert.equal(acked.length, 1);
    assert.deepEqual(acked[0], {
      messageId: `msg_${"b".repeat(32)}`,
      disposition: "accepted",
      note: "taking it",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acking a message that does not exist exits 2 without appending anything", async () => {
  const { root, ledgerPath } = workspace();
  try {
    seed(ledgerPath, [
      sentEvent({
        messageId: `msg_${"b".repeat(32)}`,
        to: { kind: "agent", agentId: "agent_bee" },
        agentId: "agent_aye",
      }),
    ]);

    const result = await runCli([
      "ack", `msg_${"c".repeat(32)}`, "--from", "agent_bee", "--database", ledgerPath,
    ], { ...dependencies, worktreeRoot: root });

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /message was not found/u);
    assert.equal(readPayloads(ledgerPath, "agent.message.acknowledged").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("send reads the message body on stdin when --body is absent", async () => {
  const { root, ledgerPath } = workspace();
  try {
    let stdinReads = 0;
    const result = await runCli([
      "send", "--to", "broadcast", "--kind", "notice",
      "--subject", "rebooting the shared checkout",
      "--from", "agent_aye", "--database", ledgerPath,
    ], {
      ...dependencies,
      worktreeRoot: root,
      readStdin: () => {
        stdinReads += 1;
        return Promise.resolve("piped body\n");
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(stdinReads, 1, "stdin is read once, only when --body is absent");
    const payloads = readPayloads<{ body: string; to: { kind: string } }>(ledgerPath, "agent.message.sent");
    assert.equal(payloads[0]?.body, "piped body", "the pipe's trailing newline does not become part of the body");
    assert.equal(payloads[0]?.to.kind, "broadcast");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json passes the mailbox results through untouched", async () => {
  const { root, ledgerPath } = workspace();
  try {
    seed(ledgerPath, [
      sentEvent({
        messageId: `msg_${"d".repeat(32)}`,
        to: { kind: "broadcast", agentId: null },
        agentId: "agent_aye",
      }),
    ]);

    const sent = await runCli([
      "send", "--to", "agent_bee", "--kind", "question", "--subject", "s", "--body", "b",
      "--from", "agent_aye", "--json", "--database", ledgerPath,
    ], { ...dependencies, worktreeRoot: root });
    assert.equal(sent.exitCode, 0);
    const messageId = (JSON.parse(sent.stdout) as { messageId: string }).messageId;
    assert.match(messageId, /^msg_[0-9a-f]{32}$/u);

    const inbox = await runCli(["inbox", "--agent", "agent_bee", "--json", "--database", ledgerPath], dependencies);
    const parsed = JSON.parse(inbox.stdout) as {
      rows: readonly {
        messageId: string;
        fromAgentId: string;
        kind: string;
        subject: string;
        body: string;
        refs: readonly string[];
        broadcast: boolean;
      }[];
      withheld: number;
      expired: number;
    };
    assert.equal(parsed.withheld, 0);
    assert.equal(parsed.expired, 0);
    // The seeded broadcast is visible to agent_bee too, so the direct question rides beside it.
    assert.equal(parsed.rows.length, 2);
    const question = parsed.rows.find((row) => row.messageId === messageId)!;
    assert.deepEqual(
      { ...question, sentAt: undefined, expiresAt: undefined },
      {
        messageId,
        fromAgentId: "agent_aye",
        kind: "question",
        subject: "s",
        body: "b",
        refs: [],
        broadcast: false,
        sentAt: undefined,
        expiresAt: undefined,
      },
    );

    const acked = await runCli([
      "ack", messageId, "--decline", "--note", "not mine", "--from", "agent_bee",
      "--json", "--database", ledgerPath,
    ], { ...dependencies, worktreeRoot: root });
    assert.equal(acked.exitCode, 0);
    assert.deepEqual(JSON.parse(acked.stdout), {
      ok: true,
      messageId,
      disposition: "declined",
      note: "not mine",
    });

    // Without a note the answer still names what was recorded, but carries no note field.
    seed(ledgerPath, [
      sentEvent({
        messageId: `msg_${"e".repeat(32)}`,
        to: { kind: "agent", agentId: "agent_bee" },
        agentId: "agent_aye",
      }),
    ]);
    const bareAck = await runCli([
      "ack", `msg_${"e".repeat(32)}`, "--from", "agent_bee", "--json", "--database", ledgerPath,
    ], { ...dependencies, worktreeRoot: root });
    assert.deepEqual(JSON.parse(bareAck.stdout), {
      ok: true,
      messageId: `msg_${"e".repeat(32)}`,
      disposition: "read",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
