import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentId,
  AgentMessageAcknowledgedEvent,
  AgentMessageDeliveredEvent,
  AgentMessageSentEvent,
  EventId,
  MessageAudience,
  MessageChannel,
  MessageId,
  ProtocolEvent,
  Source,
} from "patchmesh-protocol";
import {
  createCorrelationId,
  deterministicUuid,
  logicalPathFor,
  resolveRepositoryIdentity,
} from "patchmesh-recorder";
import { readEventsCached, SqliteEventStore } from "patchmesh-storage";
import { ReadServiceError } from "./types.js";

/**
 * The mailbox is a projection over the ledger, not a store of its own: a message is a
 * `agent.message.sent` coordination event, delivery is a per-recipient
 * `agent.message.delivered` event appended after an injection or pull, and an acknowledgement
 * appends without updating anything. Payload shapes live in the committed Phase 0 schemas,
 * which govern over any prose design (docs/superpowers/specs/2026-08-25-mailbox-design.md).
 *
 * Validation rejects rather than clamps everywhere. A message quietly shortened to fit would
 * read as sent while meaning something else; a sender told "no" knows to rewrite.
 */

export const MAILBOX_DEFAULT_TTL_DAYS = 7;

/** Deliberate abuse limits; each mirrors a maxLength/maxItems in event-payloads.schema.json. */
const SUBJECT_MAX_CHARS = 200;
const BODY_MAX_CHARS = 2048;
const REFS_MAX_ITEMS = 20;
const NOTE_MAX_CHARS = 512;

/** How many rows one inbox answer returns before the rest become a withheld count. */
const INBOX_CAP = 20;

// The agent-id shape both the identities schema and `agentIdForSession` produce; validating
// here turns what would be a raw storage validation error into a usage error the CLI maps
// to exit 2 with a readable reason.
const AGENT_ID_PATTERN = /^agent_[a-z0-9][a-z0-9._-]{0,63}$/u;
const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{32}$/u;
const MESSAGE_KINDS = new Set(["notice", "handoff", "question", "claim"]);
const ACK_DISPOSITIONS = new Set(["read", "accepted", "declined"]);

export interface SendMailOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  /** Sending agent id. Null means no resolvable attribution, and anonymous mail is rejected. */
  readonly from: string | null;
  /** An `agent_<...>` id, or the literal `broadcast`. */
  readonly to: string;
  readonly kind: "notice" | "handoff" | "question" | "claim";
  readonly subject: string;
  readonly body: string;
  readonly refs?: readonly string[] | undefined;
  /** ISO timestamp; must be in the future. Defaults to now plus MAILBOX_DEFAULT_TTL_DAYS. */
  readonly expiresAt?: string | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * Injected writer for callers that already hold an open store. Absent, this module opens
   * the ledger itself -- the same short-lived open/append/close `recordHook` uses, so a send
   * needs no daemon and no long-lived process.
   */
  readonly append?: ((events: readonly ProtocolEvent[]) => void) | undefined;
}

export function sendMail(options: SendMailOptions): { messageId: string } {
  const now = options.now ?? (() => new Date());
  const atMs = now().getTime();
  if (!Number.isFinite(atMs)) throw new ReadServiceError("usage", "send clock is invalid");

  // Sender first: a message with no attributable author is spam by construction, and every
  // other field's error message assumes someone will read it later.
  if (options.from === null || !AGENT_ID_PATTERN.test(options.from)) {
    throw new ReadServiceError("usage", "send requires a sender as an agent_<id> attribution");
  }
  const audience = audienceOf(options.to);
  if (!MESSAGE_KINDS.has(options.kind)) {
    throw new ReadServiceError("usage", "kind must be notice, handoff, question, or claim");
  }

  // Trimmed for storage because the schema pattern forbids leading/trailing whitespace;
  // rejecting the trimmed-empty case keeps a whitespace subject from becoming a blank one.
  const subject = typeof options.subject === "string" ? options.subject.trim() : "";
  if (subject === "") throw new ReadServiceError("usage", "subject is required");
  if (subject.length > SUBJECT_MAX_CHARS) {
    throw new ReadServiceError("usage", `subject exceeds ${SUBJECT_MAX_CHARS} characters`);
  }
  // A subject renders as one line inside the untrusted-message delimiters, and a body line
  // beginning with "--- " is exactly how the wrapper closes. Either embedded at write time
  // would let one message forge its way out of the trust boundary, so both are rejected
  // outright rather than escaped on render -- a sender told "no" knows to rewrite.
  if (/[\n\r]/u.test(subject)) {
    throw new ReadServiceError("usage", "subject must be a single line without newlines");
  }
  if (typeof options.body !== "string") throw new ReadServiceError("usage", "body is required");
  if (/^--- /mu.test(subject) || /^--- /mu.test(options.body)) {
    throw new ReadServiceError(
      "usage",
      'no line may begin with "--- ", which is the message delimiter',
    );
  }
  if (options.body.length > BODY_MAX_CHARS) {
    throw new ReadServiceError("usage", `body exceeds ${BODY_MAX_CHARS} characters`);
  }

  // Refs go through the same logical-path reduction file.changed carries, so a message about
  // a file joins the work on that file. Normalizing first also makes duplicate detection
  // compare destinations rather than spellings.
  const refs = (options.refs ?? []).map((candidate) => {
    if (typeof candidate !== "string") {
      throw new ReadServiceError("usage", "each ref must be a path");
    }
    const normalized = logicalPathFor(options.worktreeRoot, candidate);
    if (normalized === null) {
      throw new ReadServiceError(
        "usage",
        `ref must be a repository-relative path inside the worktree: ${candidate}`,
      );
    }
    return normalized;
  });
  if (refs.length > REFS_MAX_ITEMS) {
    throw new ReadServiceError("usage", `refs exceed ${REFS_MAX_ITEMS} entries`);
  }
  if (new Set(refs).size !== refs.length) {
    throw new ReadServiceError("usage", "refs contain duplicates");
  }

  let expiresAtMs = atMs + MAILBOX_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000;
  if (options.expiresAt !== undefined) {
    const parsed = Date.parse(options.expiresAt);
    if (Number.isNaN(parsed)) {
      throw new ReadServiceError("usage", "expiresAt must be an ISO timestamp");
    }
    // At-or-before now is rejected, not clamped to +1ms: mail born already expiring was
    // almost certainly a timezone or unit mistake worth surfacing.
    if (parsed <= atMs) throw new ReadServiceError("usage", "expiresAt must be in the future");
    expiresAtMs = parsed;
  }

  const identity = resolveRepositoryIdentity(options.worktreeRoot);
  const messageId = `msg_${randomHex(32)}` as MessageId;
  const event: AgentMessageSentEvent = {
    schemaVersion: 1,
    eventId: `evt_${randomHex(32)}` as EventId,
    eventType: "agent.message.sent",
    source: mailboxSource(identity.repositoryId),
    timestamp: new Date(atMs).toISOString(),
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    worktreeId: identity.worktreeId,
    // The sender lives on the envelope, not in the payload; the committed protocol governs.
    agentId: options.from as AgentId,
    taskId: null,
    correlationId: createCorrelationId(),
    causationId: null,
    sourceSequence: null,
    payload: {
      messageId,
      to: audience,
      kind: options.kind,
      subject,
      body: options.body,
      refs,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  };
  appendEvents(options.ledgerPath, [event], options.append);
  return { messageId };
}

function audienceOf(to: string): MessageAudience {
  if (to === "broadcast") return { kind: "broadcast", agentId: null };
  if (typeof to === "string" && AGENT_ID_PATTERN.test(to)) {
    return { kind: "agent", agentId: to as AgentId };
  }
  throw new ReadServiceError("usage", 'to must be an agent_<id> or the literal "broadcast"');
}

function mailboxSource(repositoryId: string): Source {
  return {
    kind: "gateway",
    sourceId: "source_patchmesh_mailbox",
    // Stable per repository rather than per process, so sends from different sessions still
    // group under one provenance in queries that care about where an event came from.
    instanceId: deterministicUuid("patchmesh:mailbox", repositoryId),
  };
}

function randomHex(length: number): string {
  return createHash("sha256")
    .update(`${process.pid}:${process.hrtime.bigint()}:${Math.random()}`)
    .digest("hex")
    .slice(0, length);
}

function appendEvents(
  ledgerPath: string,
  events: readonly ProtocolEvent[],
  append: ((events: readonly ProtocolEvent[]) => void) | undefined,
): void {
  if (append !== undefined) {
    append(events);
    return;
  }
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const store = SqliteEventStore.open(ledgerPath);
  try {
    store.appendAtomic(events);
  } finally {
    store.close();
  }
}

export interface InboxOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly agent: string;
  readonly includeDelivered?: boolean | undefined;
  /** Lower cap for one answer; the default stays INBOX_CAP. Must be a positive integer. */
  readonly limit?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface InboxRow {
  readonly messageId: string;
  readonly fromAgentId: string | null;
  readonly kind: string;
  readonly subject: string;
  readonly body: string;
  readonly refs: readonly string[];
  readonly sentAt: string;
  readonly expiresAt: string;
  readonly broadcast: boolean;
}

export interface InboxResult {
  readonly rows: readonly InboxRow[];
  readonly withheld: number;
  readonly expired: number;
}

export function readInbox(options: InboxOptions): InboxResult {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new ReadServiceError("usage", "limit must be a positive integer");
  }
  const nowMs = (options.now ?? (() => new Date()))().getTime();

  // Fails soft, never throws: an inbox the host cannot read still has to yield the floor so
  // a session can start. Empty-and-zero is the bounded answer, not a claim that mail exists.
  let events: readonly ProtocolEvent[];
  try {
    events = readEventsCached(
      options.ledgerPath,
      { eventTypes: ["agent.message.sent", "agent.message.delivered"] },
      { validate: false },
    );
  } catch {
    return { rows: [], withheld: 0, expired: 0 };
  }

  // Delivery is per recipient: the recipient is the delivered envelope's own agentId, which
  // is what lets one broadcast stay visible to agents that have not read it yet.
  const deliveredToSelf = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "agent.message.delivered") continue;
    const delivered = event as AgentMessageDeliveredEvent;
    if (delivered.agentId === options.agent) {
      deliveredToSelf.add(delivered.payload.messageId);
    }
  }
  // Also check sidecar delivery markers (written by PostToolUse mailbox injection)
  const deliveredDir = join(options.ledgerPath, "..", "delivered");
  try {
    if (existsSync(deliveredDir)) {
      const files = readdirSync(deliveredDir);
      for (const file of files) {
        if (!file.endsWith(`.${options.agent}`)) continue;
        const messageId = file.slice(0, -(options.agent.length + 1));
        if (messageId.startsWith("msg_")) {
          deliveredToSelf.add(messageId as MessageId);
        }
      }
    }
  } catch { /* sidecar read is best-effort */ }

  const visible: InboxRow[] = [];
  let expired = 0;
  for (const event of events) {
    if (event.eventType !== "agent.message.sent") continue;
    const sent = event as AgentMessageSentEvent;
    const to = sent.payload.to;
    const addressed =
      to.kind === "broadcast" || (to.kind === "agent" && to.agentId === options.agent);
    if (!addressed) continue;

    const expiresAtMs = Date.parse(sent.payload.expiresAt);
    // An unparseable expiry cannot be shown as unexpired, so it counts as gone rather than
    // leaking a possibly stale message into someone's context.
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
      expired += 1;
      continue;
    }
    if (!options.includeDelivered && deliveredToSelf.has(sent.payload.messageId)) continue;

    visible.push({
      messageId: sent.payload.messageId,
      fromAgentId: sent.agentId,
      kind: sent.payload.kind,
      subject: sent.payload.subject,
      body: sent.payload.body,
      refs: sent.payload.refs,
      sentAt: sent.timestamp,
      expiresAt: sent.payload.expiresAt,
      broadcast: to.kind === "broadcast",
    });
  }

  // Newest first, and an explicit limit overrides the default cap outright rather than being
  // clamped by it -- a caller asking for fifty rows made itself heard, and shrinking that to
  // twenty would be the silent clamp this codebase rejects everywhere else.
  visible.sort((left, right) =>
    left.sentAt < right.sentAt ? 1 : left.sentAt > right.sentAt ? -1 : 0);
  const cap = options.limit ?? INBOX_CAP;
  return {
    rows: visible.slice(0, cap),
    withheld: visible.length - Math.min(visible.length, cap),
    expired,
  };
}

export interface AcknowledgeMessageOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly byAgentId: string;
  readonly messageId: string;
  readonly disposition: "read" | "accepted" | "declined";
  readonly note?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly append?: ((events: readonly ProtocolEvent[]) => void) | undefined;
}

/**
 * Append one acknowledgement attributed to the acknowledger. Re-acking appends again rather
 * than updating anything -- the stream is append-only and history is the answer -- but a
 * message that does not exist or has expired is refused outright: an expired handoff cannot
 * be accepted, and acknowledging nothing would forge agreement out of a typo.
 */
export function acknowledgeMessage(
  options: AcknowledgeMessageOptions,
): { ok: boolean; reason?: string } {
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  if (!AGENT_ID_PATTERN.test(options.byAgentId)) {
    throw new ReadServiceError("usage", "byAgentId must be an agent_<id>");
  }
  if (!MESSAGE_ID_PATTERN.test(options.messageId)) {
    throw new ReadServiceError("usage", "messageId must be msg_ followed by 32 hex characters");
  }
  if (!ACK_DISPOSITIONS.has(options.disposition)) {
    throw new ReadServiceError("usage", "disposition must be read, accepted, or declined");
  }
  if (
    options.note !== undefined
    && (typeof options.note !== "string" || options.note.length > NOTE_MAX_CHARS)
  ) {
    throw new ReadServiceError("usage", `note exceeds ${NOTE_MAX_CHARS} characters`);
  }

  let events: readonly ProtocolEvent[];
  try {
    events = readEventsCached(
      options.ledgerPath,
      { eventTypes: ["agent.message.sent"] },
      { validate: false },
    );
  } catch (error) {
    throw new ReadServiceError("unavailable", `ledger is unreadable: ${String(error)}`);
  }
  const sent = events.find(
    (event): event is AgentMessageSentEvent =>
      event.eventType === "agent.message.sent"
      && event.payload.messageId === options.messageId,
  );
  if (sent === undefined) return { ok: false, reason: "message was not found" };
  const expiresAtMs = Date.parse(sent.payload.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
    return { ok: false, reason: "message has expired" };
  }

  const identity = resolveRepositoryIdentity(options.worktreeRoot);
  // Caused by the sent event, so replay ties the response to the message it answers.
  const event: AgentMessageAcknowledgedEvent = {
    schemaVersion: 1,
    eventId: `evt_${randomHex(32)}` as EventId,
    eventType: "agent.message.acknowledged",
    source: mailboxSource(identity.repositoryId),
    timestamp: new Date(nowMs).toISOString(),
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    worktreeId: identity.worktreeId,
    agentId: options.byAgentId as AgentId,
    taskId: null,
    correlationId: createCorrelationId(),
    causationId: sent.eventId,
    sourceSequence: null,
    payload: {
      messageId: options.messageId as MessageId,
      disposition: options.disposition,
      note: options.note ?? null,
    },
  };
  appendEvents(options.ledgerPath, [event], options.append);
  return { ok: true };
}

export interface MarkDeliveredOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  /** The recipient the delivery is attributed to; the envelope's own agentId. */
  readonly byAgentId: string;
  readonly channel: MessageChannel;
  readonly messageIds: readonly string[];
  readonly now?: (() => Date) | undefined;
  readonly append?: ((events: readonly ProtocolEvent[]) => void) | undefined;
}

/**
 * Mark-after-answer, shared by every pull surface (MCP inbox today, session-start delivery
 * next): one `agent.message.delivered` per message per recipient, appended only after the
 * answer was actually built. At-least-once by construction -- a crash between building and
 * marking redelivers next pull, which the design accepts; silently losing mail does not.
 * Callers that cannot attribute a recipient (a broadcast-only pull with no requesting agent)
 * pass no ids at all rather than forging one.
 */
export function markDelivered(options: MarkDeliveredOptions): void {
  if (!AGENT_ID_PATTERN.test(options.byAgentId)) {
    throw new ReadServiceError("usage", "byAgentId must be an agent_<id>");
  }
  for (const messageId of options.messageIds) {
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new ReadServiceError("usage", "each messageId must be msg_ followed by 32 hex characters");
    }
  }
  if (options.messageIds.length === 0) return;

  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const identity = resolveRepositoryIdentity(options.worktreeRoot);
  const events: AgentMessageDeliveredEvent[] = options.messageIds.map((messageId) => ({
    schemaVersion: 1,
    eventId: `evt_${randomHex(32)}` as EventId,
    eventType: "agent.message.delivered",
    source: mailboxSource(identity.repositoryId),
    timestamp: new Date(nowMs).toISOString(),
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    worktreeId: identity.worktreeId,
    agentId: options.byAgentId as AgentId,
    taskId: null,
    correlationId: createCorrelationId(),
    causationId: null,
    sourceSequence: null,
    payload: { messageId: messageId as MessageId, channel: options.channel },
  }));
  appendEvents(options.ledgerPath, events, options.append);
}

/**
 * Messages waiting for anyone: unexpired, with zero delivered events of any recipient.
 *
 * Direct mail counts until its one recipient reads it; a broadcast counts until somebody --
 * anybody -- reads it, which is the distinction the per-recipient delivered event exists to
 * keep countable.
 */
export function undeliveredCount(ledgerPath: string, now?: () => Date): number {
  const nowMs = (now ?? (() => new Date()))().getTime();
  let events: readonly ProtocolEvent[];
  try {
    events = readEventsCached(
      ledgerPath,
      { eventTypes: ["agent.message.sent", "agent.message.delivered"] },
      { validate: false },
    );
  } catch {
    return 0;
  }
  const delivered = new Set<string>();
  for (const event of events) {
    if (event.eventType === "agent.message.delivered") {
      delivered.add((event as AgentMessageDeliveredEvent).payload.messageId);
    }
  }
  // Also check sidecar delivery markers (written by PostToolUse mailbox injection)
  const deliveredDir = join(ledgerPath, "..", "delivered");
  try {
    if (existsSync(deliveredDir)) {
      const files = readdirSync(deliveredDir);
      for (const file of files) {
        const dotIdx = file.lastIndexOf(".");
        if (dotIdx > 0) {
          const messageId = file.slice(0, dotIdx);
          if (messageId.startsWith("msg_")) {
            delivered.add(messageId as MessageId);
          }
        }
      }
    }
  } catch { /* sidecar read is best-effort */ }
  let count = 0;
  for (const event of events) {
    if (event.eventType !== "agent.message.sent") continue;
    const sent = event as AgentMessageSentEvent;
    const expiresAtMs = Date.parse(sent.payload.expiresAt);
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) continue;
    if (!delivered.has(sent.payload.messageId)) count += 1;
  }
  return count;
}
