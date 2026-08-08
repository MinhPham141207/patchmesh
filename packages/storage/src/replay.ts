import {
  validateEventSet,
  type ProtocolEvent,
  type Source,
} from "@patchmesh/protocol";
import { StorageError } from "./errors.js";

export interface SourceSequenceGap {
  readonly source: Source;
  readonly missingRanges: readonly {
    readonly from: number;
    readonly to: number;
  }[];
}

export interface ReplayReducer<State> {
  initialState(): State;
  apply(state: State, event: ProtocolEvent): State;
}

export interface ReplayResult<State> {
  readonly orderedEvents: readonly ProtocolEvent[];
  readonly sourceSequenceGaps: readonly SourceSequenceGap[];
  readonly state: State;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

class MinHeap<T> {
  private readonly values: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  push(value: T): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const current = this.values[index];
      const parentValue = this.values[parent];
      if (current === undefined || parentValue === undefined || this.compare(current, parentValue) >= 0) break;
      this.values[index] = parentValue;
      this.values[parent] = current;
      index = parent;
    }
  }

  pop(): T | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (first === undefined || last === undefined) return first;
    if (this.values.length === 0) return first;
    this.values[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      const current = this.values[index];
      const leftValue = this.values[left];
      const rightValue = this.values[right];
      if (current === undefined) break;
      if (leftValue !== undefined && this.compare(leftValue, current) < 0) smallest = left;
      const smallestValue = this.values[smallest];
      if (rightValue !== undefined && smallestValue !== undefined && this.compare(rightValue, smallestValue) < 0) smallest = right;
      if (smallest === index) break;
      const next = this.values[smallest];
      if (next === undefined) break;
      this.values[index] = next;
      this.values[smallest] = current;
      index = smallest;
    }
    return first;
  }
}

function causalOrder(events: readonly ProtocolEvent[]): readonly ProtocolEvent[] {
  const eventsById = new Map<string, ProtocolEvent>();
  for (const event of events) {
    if (eventsById.has(event.eventId)) {
      throw new StorageError("PHASE0_ID_CONFLICT", "replay input contains a duplicate event ID", {
        eventId: event.eventId,
      });
    }
    eventsById.set(event.eventId, event);
  }

  const pending = new Map(eventsById);
  const childrenByParent = new Map<string, ProtocolEvent[]>();
  const ready = new MinHeap<ProtocolEvent>((left, right) => compareCodeUnits(left.eventId, right.eventId));
  for (const event of events) {
    if (event.causationId === null) {
      ready.push(event);
      continue;
    }
    const children = childrenByParent.get(event.causationId) ?? [];
    children.push(event);
    childrenByParent.set(event.causationId, children);
  }
  const ordered: ProtocolEvent[] = [];

  while (pending.size > 0) {
    const next = ready.pop();
    if (next === undefined) {
      const missing = [...pending.values()].find(
        (event) => event.causationId !== null && !eventsById.has(event.causationId),
      );
      if (missing) {
        throw new StorageError("PHASE0_REFERENCE_MISSING", "causal parent is absent", {
          eventId: missing.eventId,
          causationId: missing.causationId ?? "",
        });
      }
      throw new StorageError("M2_REPLAY_CAUSALITY_UNRESOLVED", "causal replay contains an unresolved dependency");
    }

    pending.delete(next.eventId);
    ordered.push(next);
    for (const child of childrenByParent.get(next.eventId) ?? []) ready.push(child);
  }

  return ordered;
}

function sourceKey(source: Source): string {
  return `${source.kind}:${source.sourceId}:${source.instanceId}`;
}

function sourceSequenceGaps(events: readonly ProtocolEvent[]): readonly SourceSequenceGap[] {
  const groups = new Map<string, { readonly source: Source; readonly sequences: number[] }>();
  for (const event of events) {
    if (event.sourceSequence === null) continue;
    const key = sourceKey(event.source);
    const group = groups.get(key);
    if (group) {
      group.sequences.push(event.sourceSequence);
    } else {
      groups.set(key, { source: event.source, sequences: [event.sourceSequence] });
    }
  }

  const gaps: SourceSequenceGap[] = [];
  for (const group of [...groups.values()].sort((left, right) => compareCodeUnits(sourceKey(left.source), sourceKey(right.source)))) {
    const sequences = [...new Set(group.sequences)].sort((left, right) => left - right);
    const missingRanges: Array<{ from: number; to: number }> = [];
    for (let index = 1; index < sequences.length; index += 1) {
      const previous = sequences[index - 1];
      const current = sequences[index];
      if (previous === undefined || current === undefined || current <= previous + 1) continue;
      missingRanges.push({ from: previous + 1, to: current - 1 });
    }
    if (missingRanges.length > 0) gaps.push({ source: group.source, missingRanges });
  }
  return gaps;
}

function replayValidationError(
  diagnostics: readonly { readonly code: string; readonly message: string }[],
): StorageError {
  const transitionMessages = new Set([
    "tool completion request must be a tool.requested event",
    "tool completion does not match its request domain",
    "tool completion must be caused by its request or declared effect",
    "child must inherit parent correlation ID",
    "causal child must advance its producer sequence",
    "one correlation cannot have multiple roots",
    "attribution target crosses repository, domain, or correlation",
    "attribution correction must supply an identity",
  ]);
  const code = diagnostics.some((diagnostic) => diagnostic.code === "PHASE0_REFERENCE_MISSING")
    ? "PHASE0_REFERENCE_MISSING"
    : diagnostics.some((diagnostic) => transitionMessages.has(diagnostic.message))
      ? "PHASE0_TRANSITION_INVALID"
      : diagnostics[0]?.code ?? "PHASE0_TRANSITION_INVALID";
  return new StorageError(code, "replay event-set validation failed", { diagnosticCode: code });
}

export function replayEvents(events: readonly ProtocolEvent[]): ReplayResult<readonly ProtocolEvent[]>;
export function replayEvents<State>(events: readonly ProtocolEvent[], reducer: ReplayReducer<State>): ReplayResult<State>;
export function replayEvents<State>(
  events: readonly ProtocolEvent[],
  reducer?: ReplayReducer<State>,
): ReplayResult<State | readonly ProtocolEvent[]> {
  const orderedEvents = causalOrder(events);
  const diagnostics = validateEventSet(orderedEvents);
  if (diagnostics.length > 0) throw replayValidationError(diagnostics);

  const frozenEvents = deepFreeze([...orderedEvents]);
  const gaps = deepFreeze([...sourceSequenceGaps(orderedEvents)]);
  if (!reducer) {
    return deepFreeze({ orderedEvents: frozenEvents, sourceSequenceGaps: gaps, state: frozenEvents });
  }

  let state = reducer.initialState();
  for (const event of frozenEvents) state = reducer.apply(state, event);
  return deepFreeze({ orderedEvents: frozenEvents, sourceSequenceGaps: gaps, state });
}
