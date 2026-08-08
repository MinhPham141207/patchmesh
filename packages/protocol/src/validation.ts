import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { default as addFormats } from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import type {
  AttributionCorrectedEvent,
  ProtocolEvent,
  ToolCompletedEvent,
} from "./events.js";
import type { EventId, Source } from "./identities.js";
import {
  type ValidationDiagnostic,
  type ValidationResult,
} from "./diagnostics.js";

const schemaNames = [
  "identities",
  "event-payloads",
  "event-envelope",
  "dependency",
  "coverage",
  "finding",
  "decision",
  "task-validity",
] as const;

const schemaDirectory = new URL("../../../schemas/phase0/v1/", import.meta.url);

function readSchema(name: (typeof schemaNames)[number]): Record<string, unknown> {
  const path = fileURLToPath(new URL(`${name}.schema.json`, schemaDirectory));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function createValidator(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const registerFormats = addFormats as unknown as (instance: Ajv2020) => Ajv2020;
  registerFormats(ajv);
  for (const name of schemaNames) ajv.addSchema(readSchema(name));
  return ajv.getSchema("https://patchmesh.dev/schemas/phase0/v1/event-envelope.schema.json") ??
    (() => {
      throw new Error("event envelope schema was not registered");
    })();
}

const validateEnvelope = createValidator();

function diagnostic(code: string, path: string, message: string): ValidationDiagnostic {
  return { code, path, message };
}

function ajvDiagnostic(error: ErrorObject): ValidationDiagnostic {
  const path = error.keyword === "required"
    ? `${error.instancePath}/${String(error.params.missingProperty)}`
    : error.instancePath || "/";
  return diagnostic("PHASE0_SCHEMA_INVALID", path, `schema validation failed (${error.keyword})`);
}

function sortDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEvent(input: unknown): ValidationResult<ProtocolEvent> {
  if (!isRecord(input)) {
    return { value: null, diagnostics: [diagnostic("PHASE0_SCHEMA_INVALID", "/", "event must be an object")] };
  }
  if (Object.hasOwn(input, "schemaVersion") && input.schemaVersion !== 1) {
    return { value: null, diagnostics: [diagnostic("PHASE0_SCHEMA_UNSUPPORTED", "/schemaVersion", "schema version is unsupported")] };
  }
  if (!validateEnvelope(input)) {
    return { value: null, diagnostics: sortDiagnostics((validateEnvelope.errors ?? []).map(ajvDiagnostic)) };
  }
  return { value: cloneAndFreeze(input as unknown as ProtocolEvent), diagnostics: [] };
}

function producerKey(source: Source): string {
  return `${source.kind}:${source.sourceId}:${source.instanceId}`;
}

function sameDomain(left: ProtocolEvent, right: ProtocolEvent): boolean {
  return left.repositoryId === right.repositoryId &&
    left.workspaceId === right.workspaceId &&
    left.worktreeId === right.worktreeId;
}

function sameVersionDomain(event: ProtocolEvent, version: { domain: { repositoryId: string; workspaceId: string; worktreeId: string } }): boolean {
  return event.repositoryId === version.domain.repositoryId &&
    event.workspaceId === version.domain.workspaceId &&
    event.worktreeId === version.domain.worktreeId;
}

function validateToolCompletion(
  event: ToolCompletedEvent,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
  diagnostics: ValidationDiagnostic[],
): void {
  const request = eventsById.get(event.payload.requestEventId);
  if (!request) {
    diagnostics.push(diagnostic("PHASE0_REFERENCE_MISSING", `/events/${event.eventId}/payload/requestEventId`, "referenced request event is absent"));
    return;
  }
  if (request.eventType !== "tool.requested") {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/requestEventId`, "tool completion request must be a tool.requested event"));
  }
  if (!sameDomain(event, request) || event.correlationId !== request.correlationId) {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/requestEventId`, "tool completion does not match its request domain"));
  }
  if (event.causationId !== event.payload.requestEventId && !event.payload.effectEventIds.includes(event.causationId as EventId)) {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "tool completion must be caused by its request or declared effect"));
  }
}

function validateAttributionCorrection(
  event: AttributionCorrectedEvent,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
  diagnostics: ValidationDiagnostic[],
): void {
  const target = eventsById.get(event.payload.targetEventId);
  if (!target) {
    diagnostics.push(diagnostic("PHASE0_REFERENCE_MISSING", `/events/${event.eventId}/payload/targetEventId`, "attribution target is absent"));
  } else if (!sameDomain(event, target) || event.correlationId !== target.correlationId) {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/targetEventId`, "attribution target crosses repository, domain, or correlation"));
  }
  if (event.payload.attributedAgentId === null && event.payload.attributedTaskId === null) {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload`, "attribution correction must supply an identity"));
  }
}

function validateResourcePayload(event: ProtocolEvent, diagnostics: ValidationDiagnostic[]): void {
  if (event.eventType === "file.read" || event.eventType === "symbol.read") {
    const payload = event.payload;
    if (payload.resource.repositoryId !== event.repositoryId) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/resource/repositoryId`, "logical resource crosses event repository"));
    }
    if (payload.resource.resourceId !== payload.version.resourceId || !sameVersionDomain(event, payload.version)) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/version`, "observed version does not match its event domain or resource"));
    }
  }
  if (event.eventType === "file.changed" || event.eventType === "symbol.changed") {
    const payload = event.payload;
    if (payload.resource.repositoryId !== event.repositoryId) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/resource/repositoryId`, "logical resource crosses event repository"));
    }
    for (const version of [payload.beforeVersion, payload.afterVersion]) {
      if (version && (version.resourceId !== payload.resource.resourceId || !sameVersionDomain(event, version))) {
        diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload`, "changed version does not match its event domain or resource"));
      }
    }
  }
}

export function validateEventSet(events: readonly ProtocolEvent[]): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const eventsById = new Map<EventId, ProtocolEvent>();
  const sequenceByProducer = new Map<string, EventId>();
  const rootsByCorrelation = new Map<string, EventId>();

  for (const event of events) {
    if (!eventsById.has(event.eventId)) eventsById.set(event.eventId, event);
  }

  for (const event of events) {
    if (event.causationId === event.eventId) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "event cannot cause itself"));
    } else if (event.causationId !== null) {
      const parent = eventsById.get(event.causationId);
      if (!parent) {
        diagnostics.push(diagnostic("PHASE0_REFERENCE_MISSING", `/events/${event.eventId}/causationId`, "causal parent is absent"));
      } else {
        if (parent.correlationId !== event.correlationId) {
          diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/correlationId`, "child must inherit parent correlation ID"));
        }
        if (producerKey(parent.source) === producerKey(event.source) && parent.sourceSequence !== null && event.sourceSequence !== null && event.sourceSequence <= parent.sourceSequence) {
          diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/sourceSequence`, "causal child must advance its producer sequence"));
        }
      }
    } else {
      const root = rootsByCorrelation.get(event.correlationId);
      if (root && root !== event.eventId) {
        diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "one correlation cannot have multiple roots"));
      } else {
        rootsByCorrelation.set(event.correlationId, event.eventId);
      }
    }

    if (event.sourceSequence !== null) {
      const sequenceKey = `${producerKey(event.source)}:${event.sourceSequence}`;
      const previous = sequenceByProducer.get(sequenceKey);
      if (previous && previous !== event.eventId) {
        diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/sourceSequence`, "source sequence is duplicated in one producer instance"));
      } else {
        sequenceByProducer.set(sequenceKey, event.eventId);
      }
    }

    if (event.eventType === "tool.completed") validateToolCompletion(event, eventsById, diagnostics);
    if (event.eventType === "attribution.corrected") validateAttributionCorrection(event, eventsById, diagnostics);
    validateResourcePayload(event, diagnostics);
  }

  for (const event of events) {
    const visited = new Set<EventId>([event.eventId]);
    let current = event;
    while (current.causationId !== null) {
      if (visited.has(current.causationId)) {
        diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "causal graph contains a cycle"));
        break;
      }
      visited.add(current.causationId);
      const parent = eventsById.get(current.causationId);
      if (!parent) break;
      current = parent;
    }
  }

  return sortDiagnostics(diagnostics);
}
