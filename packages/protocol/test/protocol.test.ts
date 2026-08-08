import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProtocolValidationError,
  parseEvent,
  validateEventSet,
} from "../src/index.js";
import type { ProtocolEvent } from "../src/index.js";
import {
  makeAllTypedEvents,
  makeAttributionCorrected,
  makeToolCompleted,
  makeToolRequested,
} from "./fixtures.js";

const acceptsProtocolEvent = (_event: ProtocolEvent): void => undefined;

test("typed fixtures cover the full closed V1 event union", () => {
  const events = makeAllTypedEvents();
  for (const event of events) acceptsProtocolEvent(event);
  assert.deepEqual(events.map((event) => event.eventType), [
    "tool.requested",
    "tool.completed",
    "file.read",
    "file.changed",
    "symbol.read",
    "symbol.changed",
    "task.completed",
    "dependency.changed",
    "attribution.corrected",
    "finding.created",
    "decision.created",
    "validity.changed",
    "decision.delivery.changed",
  ]);
});

test("typed tool completion supports failed and interrupted outcomes", () => {
  const request = makeToolRequested();
  assert.equal(makeToolCompleted(request, "failed").payload.outcome, "failed");
  assert.equal(makeToolCompleted(request, "interrupted").payload.outcome, "interrupted");
});

test("typed tool events preserve nullable task attribution", () => {
  const request = makeToolRequested();
  assert.equal(request.agentId, "agent_a");
  assert.equal(request.taskId, null);
});

test("protocol validation errors expose sanitized diagnostics", () => {
  const error = new ProtocolValidationError([
    { code: "PHASE0_SCHEMA_INVALID", path: "/taskId", message: "required property is missing" },
  ]);
  assert.equal(error.name, "ProtocolValidationError");
  assert.deepEqual(error.diagnostics, [
    { code: "PHASE0_SCHEMA_INVALID", path: "/taskId", message: "required property is missing" },
  ]);
});

test("accepts a valid tool request at the boundary", () => {
  const result = parseEvent(makeToolRequested());
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.value?.eventType, "tool.requested");
});

test("rejects a payload for the wrong event type", () => {
  const result = parseEvent({
    ...makeToolRequested(),
    eventType: "tool.completed",
  });
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0]?.code, "PHASE0_SCHEMA_INVALID");
});

test("rejects an unsupported schema version", () => {
  const result = parseEvent({ ...makeToolRequested(), schemaVersion: 2 });
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0]?.code, "PHASE0_SCHEMA_UNSUPPORTED");
});

test("requires nullable attribution fields to be present", () => {
  const event = { ...makeToolRequested() } as Record<string, unknown>;
  delete event.taskId;
  const result = parseEvent(event);
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0]?.path, "/taskId");
});

test("accepts failed and interrupted tool outcomes", () => {
  const request = makeToolRequested();
  assert.equal(parseEvent(makeToolCompleted(request, "failed")).value?.eventType, "tool.completed");
  assert.equal(parseEvent(makeToolCompleted(request, "interrupted")).value?.eventType, "tool.completed");
});

test("accepts every Phase 1 input event shape at the boundary", () => {
  for (const event of makeAllTypedEvents().slice(0, 9)) {
    const result = parseEvent(event);
    assert.deepEqual(result.diagnostics, [], event.eventType);
    assert.equal(result.value?.eventType, event.eventType);
  }
});

test("preserves event identity and sequencing values through parsing", () => {
  const request = makeToolRequested();
  const result = parseEvent(request);
  assert.deepEqual(result.value, request);
});

test("accepts a causally ordered request and completion set", () => {
  const request = makeToolRequested();
  const completion = makeToolCompleted(request);
  assert.deepEqual(validateEventSet([request, completion]), []);
});

test("rejects a completion whose request is missing", () => {
  const completion = makeToolCompleted();
  const missingRequest = `evt_${"9".repeat(32)}`;
  const invalidCompletion = {
    ...completion,
    causationId: missingRequest,
    payload: { ...completion.payload, requestEventId: missingRequest },
  };
  const diagnostics = validateEventSet([invalidCompletion]);
  assert.equal(diagnostics[0]?.code, "PHASE0_REFERENCE_MISSING");
});

test("rejects a causal parent from another correlation", () => {
  const request = makeToolRequested();
  const completion = makeToolCompleted(request);
  const invalidRequest = { ...request, correlationId: "corr_99999999999999999999999999999999" };
  assert.equal(validateEventSet([invalidRequest, completion])[0]?.code, "PHASE0_SCHEMA_INVALID");
});

test("rejects a same-producer causal child that does not advance sequence", () => {
  const request = makeToolRequested();
  const completion = { ...makeToolCompleted(request), sourceSequence: 0 };
  assert.equal(validateEventSet([request, completion])[0]?.code, "PHASE0_SCHEMA_INVALID");
});

test("validates immutable attribution corrections against their target", () => {
  const request = makeToolRequested();
  assert.deepEqual(validateEventSet([request, makeAttributionCorrected()]), []);
});

test("rejects an attribution correction with a missing target", () => {
  const correction = makeAttributionCorrected();
  const invalidCorrection = {
    ...correction,
    payload: { ...correction.payload, targetEventId: `evt_${"9".repeat(32)}` },
  };
  assert.equal(validateEventSet([invalidCorrection])[0]?.code, "PHASE0_REFERENCE_MISSING");
});

test("rejects an attribution correction without an identity", () => {
  const request = makeToolRequested();
  const correction = makeAttributionCorrected();
  const invalidCorrection = {
    ...correction,
    payload: { ...correction.payload, attributedAgentId: null, attributedTaskId: null },
  };
  assert.equal(validateEventSet([request, invalidCorrection])[0]?.code, "PHASE0_SCHEMA_INVALID");
});
