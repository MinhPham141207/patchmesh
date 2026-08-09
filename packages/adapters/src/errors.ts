import type { EventId } from "@patchmesh/protocol";

export type McpProxyStorageErrorCode =
  | "MCP_REQUEST_PERSIST_FAILED"
  | "MCP_COMPLETION_PERSIST_FAILED"
  | "MCP_DEPENDENT_WRITE_PERSIST_FAILED";

export class McpProxyStorageError extends Error {
  readonly code: McpProxyStorageErrorCode;
  readonly phase: "request" | "completion" | "dependent-write";
  readonly requestEventId: EventId | null;
  readonly executionOutcome: "succeeded" | "failed" | "interrupted" | null;

  constructor(
    code: McpProxyStorageErrorCode,
    phase: "request" | "completion" | "dependent-write",
    requestEventId: EventId | null,
    executionOutcome: "succeeded" | "failed" | "interrupted" | null,
    options?: ErrorOptions,
  ) {
    const requestDescription = requestEventId === null ? "no request event" : requestEventId;
    super(`${code} during ${phase} persistence (${requestDescription})`, options);
    this.name = "McpProxyStorageError";
    this.code = code;
    this.phase = phase;
    this.requestEventId = requestEventId;
    this.executionOutcome = executionOutcome;
  }
}
