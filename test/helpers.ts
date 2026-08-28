import type {
  ToolConfig,
  ToolExtra,
  ToolHandler,
  ToolRegistrar,
  ToolResult,
} from "../src/core/index.js";

/** In-memory stand-in for the SDK server: captures registered tools so tests
 *  can drive them directly, no stdio client needed. */
export class FakeRegistrar implements ToolRegistrar {
  readonly tools = new Map<string, ToolHandler>();

  registerTool(name: string, _config: ToolConfig, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  async invoke(name: string, args: unknown, extra: ToolExtra = {}): Promise<ToolResult> {
    const handler = this.tools.get(name);
    if (!handler) throw new Error(`Tool ${name} is not registered`);
    return handler(args, extra);
  }
}

/** Extract the structured payload of a tool result. */
export function structured(res: ToolResult): Record<string, any> {
  if (!res.structuredContent) throw new Error("expected structuredContent on tool result");
  return res.structuredContent;
}
