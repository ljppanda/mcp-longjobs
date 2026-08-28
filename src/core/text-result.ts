/**
 * A tool result that is one JSON document — readable as text by any model and
 * machine-readable via structuredContent for hosts with structured tool output.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function textResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
