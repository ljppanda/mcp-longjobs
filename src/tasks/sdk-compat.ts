import type { ToolRegistrar } from "../core/types.js";

/**
 * Adapt a real `McpServer` (or anything with a compatible `registerTool`) to
 * the structural `ToolRegistrar` interface.
 *
 * The cast is safe at runtime: the SDK's `registerTool(name, config, handler)`
 * takes a config object with an optional Zod raw shape and an async handler
 * returning `{ content: [...] }` — exactly what mcp-longjobs produces. Typing
 * is intentionally loose so the package does not break across SDK versions
 * (the 2026-07-28 stateless rewrite being the first of those).
 */
export function asToolRegistrar(server: unknown): ToolRegistrar {
  return server as ToolRegistrar;
}
