import { randomUUID } from "node:crypto";
import type { EventId } from "@patchmesh/protocol";
import type {
  McpCallContext,
  McpProxyOptions,
  McpProxyResult,
  McpToolCall,
  ToolExecutor,
} from "./types.js";

export class McpProxy {
  private readonly createEventId: () => EventId;
  private readonly now: () => string;

  constructor(options: McpProxyOptions) {
    this.createEventId = options.createEventId ?? (() => `evt_${randomUUID()}` as EventId);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  execute<T>(
    _call: McpToolCall,
    _context: McpCallContext,
    _executor: ToolExecutor<T>,
    _signal?: AbortSignal,
  ): Promise<McpProxyResult<T>> {
    void this.createEventId;
    void this.now;
    throw new Error("McpProxy.execute is not implemented");
  }
}
