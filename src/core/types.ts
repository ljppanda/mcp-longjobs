import type { ToolResult } from "./text-result.js";

/**
 * Minimal structural surface of an MCP SDK server's tool registry.
 *
 * mcp-longjobs deliberately depends on this interface instead of the SDK's
 * concrete types, so it stays testable without a live client and survives SDK
 * churn (including the 2026-07-28 stateless rewrite). `asToolRegistrar()`
 * adapts a real McpServer instance.
 */
export interface ToolConfig {
  title?: string;
  description?: string;
  /** Zod raw shape, e.g. `{ url: z.string() }` — passed straight to the SDK. */
  inputSchema?: Record<string, unknown>;
}

export interface ToolExtra {
  signal?: AbortSignal;
  sessionId?: string;
  sendNotification?: (notification: {
    method: string;
    params?: Record<string, unknown>;
  }) => Promise<void>;
  /** Per-request metadata; carries the client's progressToken when present. */
  _meta?: Record<string, unknown>;
}

export type ToolHandler = (args: unknown, extra: ToolExtra) => Promise<ToolResult>;

export interface ToolRegistrar {
  registerTool(name: string, config: ToolConfig, handler: ToolHandler): void;
}
