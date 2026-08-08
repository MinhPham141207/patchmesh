import {
  parseEvent,
  ProtocolValidationError,
  validateEventSet,
  type ProtocolEvent,
} from "@patchmesh/protocol";

export interface EventCollector {
  collect(input: unknown): ProtocolEvent;
  read(): readonly ProtocolEvent[];
}

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  if (clone && typeof clone === "object") {
    for (const child of Object.values(clone as Record<string, unknown>)) cloneAndFreeze(child);
    Object.freeze(clone);
  }
  return clone;
}

export class InMemoryEventCollector implements EventCollector {
  private readonly events: ProtocolEvent[] = [];

  collect(input: unknown): ProtocolEvent {
    const result = parseEvent(input);
    if (result.value === null) throw new ProtocolValidationError(result.diagnostics);

    const candidateEvents = [...this.events, result.value];
    const diagnostics = validateEventSet(candidateEvents);
    if (diagnostics.length > 0) throw new ProtocolValidationError(diagnostics);

    this.events.push(result.value);
    return result.value;
  }

  read(): readonly ProtocolEvent[] {
    return this.events.map((event) => cloneAndFreeze(event));
  }
}
