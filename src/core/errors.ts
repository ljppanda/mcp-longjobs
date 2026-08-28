/**
 * Structured, model-repairable error envelope.
 *
 * Plain MCP tool failures hand the model a freeform stack trace and let it
 * guess whether to retry. This envelope carries the three things a model
 * needs to repair a call in ONE round-trip: what went wrong (code/param),
 * whether trying again can work (retryable), and what to do instead
 * (recoveryHint / partial).
 */
export interface SerializedDurableError {
  /** Machine-readable code the model can branch on (e.g. "offset_mismatch"). */
  code: string;
  message: string;
  /** Whether retrying the same operation can plausibly succeed. */
  retryable: boolean;
  /** Offending argument name, when the failure is caused by one. */
  param?: string;
  /** Instruction the model can follow to repair the call. */
  recoveryHint?: string;
  /** What already succeeded, so a retry can resume instead of restart. */
  partial?: { cursor?: string | number; detail?: string };
}

export class DurableError extends Error implements SerializedDurableError {
  readonly code: string;
  readonly retryable: boolean;
  readonly param?: string;
  readonly recoveryHint?: string;
  readonly partial?: SerializedDurableError["partial"];

  constructor(options: {
    code: string;
    message: string;
    retryable?: boolean;
    param?: string;
    recoveryHint?: string;
    partial?: SerializedDurableError["partial"];
  }) {
    super(options.message);
    this.name = "DurableError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.param = options.param;
    this.recoveryHint = options.recoveryHint;
    this.partial = options.partial;
  }

  toJSON(): SerializedDurableError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.param !== undefined ? { param: this.param } : {}),
      ...(this.recoveryHint !== undefined ? { recoveryHint: this.recoveryHint } : {}),
      ...(this.partial !== undefined ? { partial: this.partial } : {}),
    };
  }
}

/**
 * Convert anything thrown into the envelope. Unknown errors become
 * non-retryable "internal_error" — the model should report, not retry.
 */
export function serializeError(error: unknown): SerializedDurableError {
  if (error instanceof DurableError) return error.toJSON();
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "internal_error",
    message,
    retryable: false,
    recoveryHint: "Report this failure to the user; do not retry blindly.",
  };
}
