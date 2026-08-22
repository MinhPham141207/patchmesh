import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createFindingFeedbackCreatedEvent,
  createDecisionDeliveryChangedEvent,
  createPhase2RuntimeRecords,
  createSameSymbolRuntimeRecords,
} from "patchmesh-core";
import { createReadServices, ReadServiceError, type EventReader, type ReadServices } from "patchmesh-query";
import type { DecisionCreatedEvent, DecisionDelivery, DecisionDeliveryChangedEvent, DecisionId, FindingFeedbackCreatedEvent, FindingId, ProtocolEvent } from "patchmesh-protocol";
import { SqliteEventStore, type AppendResult, type PruneResult } from "patchmesh-storage";

export interface DaemonOptions {
  readonly reader?: EventReader;
  readonly databasePath?: string;
}

export interface DaemonHealth {
  readonly health: "healthy" | "degraded" | "unavailable";
  readonly store: { readonly state: "open" | "closed"; readonly replayable: boolean };
  readonly errorCategory: string | null;
}

export interface FindingFeedbackInput {
  readonly findingId: FindingId;
  readonly decisionId: FindingFeedbackCreatedEvent["payload"]["feedback"]["decisionId"];
  readonly actor: FindingFeedbackCreatedEvent["payload"]["feedback"]["actor"];
  readonly disposition: FindingFeedbackCreatedEvent["payload"]["feedback"]["disposition"];
  readonly useful: FindingFeedbackCreatedEvent["payload"]["feedback"]["useful"];
  readonly reason: FindingFeedbackCreatedEvent["payload"]["feedback"]["reason"];
}

export interface DecisionDeliveryInput {
  readonly decisionId: DecisionId;
  readonly state: DecisionDelivery["state"];
}

function responseDigest(input: FindingFeedbackInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function persistDerivedRecord(
  store: SqliteEventStore,
  record: { readonly finding: ProtocolEvent; readonly decision: ProtocolEvent },
): { readonly finding: AppendResult; readonly decision: AppendResult } {
  // appendAtomic returns exactly one result per input, in input order.
  const [finding, decision] = store.appendAtomic(
    [record.finding, record.decision],
    { requireValidEventSet: true },
  );
  return { finding: finding!, decision: decision! };
}

export interface PatchMeshDaemon {
  readonly services: ReadServices;
  readonly health: () => DaemonHealth;
  /**
   * Appends an immutable response to a Phase 2 finding. Readers supplied directly
   * to the daemon deliberately remain read-only; feedback requires its durable
   * SQLite event-store boundary.
   */
  recordFindingFeedback(event: FindingFeedbackCreatedEvent): AppendResult;
  /** Creates a provenance-derived, deterministic immutable finding response. */
  respondToFinding(input: FindingFeedbackInput): AppendResult;
  /** Appends an immutable delivery-state transition for a Phase 2 decision. */
  recordDecisionDelivery(event: DecisionDeliveryChangedEvent): AppendResult;
  /** Creates a provenance-derived, deterministic immutable delivery response. */
  respondToDecisionDelivery(input: DecisionDeliveryInput): AppendResult;
  /** Replays durable evidence and appends report-only same-symbol findings. */
  runSameSymbolDetection(): readonly {
    readonly finding: AppendResult;
    readonly decision: AppendResult;
  }[];
  /** Replays all durable Phase 2 detector evidence and appends report-only findings. */
  runPhase2Detection(): readonly {
    readonly finding: AppendResult;
    readonly decision: AppendResult;
  }[];
  /**
   * Deletes events past a retention cutoff, keeping causal replay intact.
   *
   * A maintenance write rather than a report, so it lives beside the other writers and needs
   * the same durable store: readers supplied directly to the daemon stay read-only.
   */
  prune(options: { readonly olderThan: Date }): PruneResult;
  close(): void;
}

export function createDaemon(options: DaemonOptions): PatchMeshDaemon {
  if (options.reader !== undefined && options.databasePath !== undefined) {
    throw new ReadServiceError("usage", "provide a reader or database path, not both");
  }
  if (options.reader === undefined && options.databasePath === undefined) {
    throw new ReadServiceError("unavailable", "an event reader or existing database path is required");
  }
  let store: SqliteEventStore | null = null;
  const reader = options.reader ?? (() => {
    if (options.databasePath === undefined || !existsSync(options.databasePath)) {
      throw new ReadServiceError("unavailable", "database is unavailable");
    }
    store = SqliteEventStore.open(options.databasePath);
    return store;
  })();
  const services = createReadServices({ reader });
  return {
    services,
    health: () => {
      const status = services.getStatus();
      return {
        health: status.health,
        store: status.store,
        errorCategory: status.errorCategory,
      };
    },
    prune: (options) => {
      if (store === null) {
        throw new ReadServiceError("unavailable", "prune requires a writable event store");
      }
      return store.prune(options);
    },
    recordFindingFeedback: (event) => {
      if (store === null) {
        throw new ReadServiceError("unavailable", "finding feedback requires a writable event store");
      }
      return store.append(event);
    },
    respondToFinding: (input) => {
      if (store === null) {
        throw new ReadServiceError("unavailable", "finding feedback requires a writable event store");
      }
      const writableStore = store;
      const events = writableStore.read();
      const findingEvent = events.find((event) => event.eventType === "finding.created" && event.payload.finding.findingId === input.findingId);
      if (findingEvent === undefined) throw new ReadServiceError("cursor", "finding was not found");
      if (input.decisionId !== null && !events.some((event) => event.eventType === "decision.created"
        && event.payload.decision.decisionId === input.decisionId
        && event.payload.decision.findingId === input.findingId)) {
        throw new ReadServiceError("cursor", "decision does not belong to finding");
      }
      const digest = responseDigest(input);
      return writableStore.append(createFindingFeedbackCreatedEvent({
        ...input,
        feedbackId: `feedback_${digest.slice(0, 32)}`,
        evidenceEventIds: [findingEvent.eventId],
      }, {
        eventId: `evt_${digest.slice(32, 64)}`,
        repositoryId: findingEvent.repositoryId,
        workspaceId: findingEvent.workspaceId,
        worktreeId: findingEvent.worktreeId,
        correlationId: findingEvent.correlationId,
        causationId: findingEvent.eventId,
        source: { kind: "core", sourceId: "source_phase2", instanceId: "00000000-0000-4000-8000-000000000002" },
        timestamp: findingEvent.timestamp,
        sourceSequence: null,
      }));
    },
    recordDecisionDelivery: (event) => {
      if (store === null) {
        throw new ReadServiceError("unavailable", "decision delivery requires a writable event store");
      }
      return store.append(event);
    },
    respondToDecisionDelivery: (input) => {
      if (store === null) {
        throw new ReadServiceError("unavailable", "decision delivery requires a writable event store");
      }
      const writableStore = store;
      const decisionEvent = writableStore.read().find((event): event is DecisionCreatedEvent => event.eventType === "decision.created"
        && event.payload.decision.decisionId === input.decisionId);
      if (decisionEvent === undefined) throw new ReadServiceError("cursor", "decision was not found");
      const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      return writableStore.append(createDecisionDeliveryChangedEvent({
        decisionId: input.decisionId,
        delivery: {
          deliveryId: `delivery_${digest.slice(0, 32)}`,
          target: decisionEvent.payload.decision.target,
          state: input.state,
          eventIds: [decisionEvent.eventId],
        },
      }, {
        eventId: `evt_${digest.slice(32, 64)}`,
        repositoryId: decisionEvent.repositoryId,
        workspaceId: decisionEvent.workspaceId,
        worktreeId: decisionEvent.worktreeId,
        correlationId: decisionEvent.correlationId,
        causationId: decisionEvent.eventId,
        source: { kind: "core", sourceId: "source_phase2", instanceId: "00000000-0000-4000-8000-000000000002" },
        timestamp: decisionEvent.timestamp,
        sourceSequence: null,
      }));
    },
    runSameSymbolDetection: () => {
      if (store === null) {
        throw new ReadServiceError("unavailable", "same-symbol detection requires a writable event store");
      }
      const writableStore = store;
      let records: ReturnType<typeof createSameSymbolRuntimeRecords>;
      try {
        records = createSameSymbolRuntimeRecords(writableStore.replay().orderedEvents);
      } catch (cause) {
        throw new ReadServiceError(
          "unavailable",
          "same-symbol detection is unavailable because durable replay validation failed",
          { cause },
        );
      }
      try {
        return records.map((record) => persistDerivedRecord(writableStore, record));
      } catch (cause) {
        throw new ReadServiceError(
          "unavailable",
          "same-symbol detection could not persist derived records",
          { cause },
        );
      }
    },
    runPhase2Detection: () => {
      if (store === null) {
        throw new ReadServiceError("unavailable", "Phase 2 detection requires a writable event store");
      }
      const writableStore = store;
      let records: ReturnType<typeof createPhase2RuntimeRecords>;
      try {
        records = createPhase2RuntimeRecords(writableStore.replay().orderedEvents);
      } catch (cause) {
        throw new ReadServiceError(
          "unavailable",
          "Phase 2 detection is unavailable because durable replay validation failed",
          { cause },
        );
      }
      try {
        return records.map((record) => persistDerivedRecord(writableStore, record));
      } catch (cause) {
        throw new ReadServiceError(
          "unavailable",
          "Phase 2 detection could not persist derived records",
          { cause },
        );
      }
    },
    close: () => {
      store?.close();
      store = null;
    },
  };
}
