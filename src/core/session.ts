import type { SerializedDurableError } from "./errors.js";

/**
 * Lifecycle vocabulary mirrors the MCP Tasks extension (io.modelcontextprotocol/tasks)
 * so the native adapter can adopt the same states without a breaking change.
 */
export type SessionStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface SessionRecord {
  id: string;
  /** "task" = long-running operation; "transfer" = chunked file transfer. */
  kind: "task" | "transfer";
  /** Tool that created the session, if any. */
  tool?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** How long the record is kept before it may be garbage-collected. */
  ttlMs: number;
  /** Last reported progress. */
  progress?: { message?: string; fraction?: number };
  /** Final payload when status is "completed". */
  result?: unknown;
  /** Structured, model-repairable failure when status is "failed". */
  error?: SerializedDurableError;
  /** Resume cursor: byte offset for transfers; reserved for tasks. */
  cursor?: number | string;
  /** Free-form metadata (pending questions, staging paths, ...). */
  meta?: Record<string, unknown>;
}

/**
 * Persistence boundary for durable sessions.
 *
 * Everything a client needs to resume after a restart lives in the record, so
 * the choice of backend decides the durability guarantee: memory survives
 * nothing, the JSON file survives server restarts, Redis/SQLite would survive
 * machine restarts. All methods are async so backends can be remote.
 */
export interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  update(id: string, patch: Partial<Omit<SessionRecord, "id">>): Promise<SessionRecord | null>;
  delete(id: string): Promise<void>;
  list(filter?: { kind?: SessionRecord["kind"]; status?: SessionStatus }): Promise<SessionRecord[]>;
}
