import { DatabaseSync } from "node:sqlite";
import type { SerializedDurableError } from "../errors.js";
import type { SessionRecord, SessionStatus, SessionStore } from "../session.js";

/**
 * SQLite-backed store using Node's built-in `node:sqlite` (zero dependencies;
 * experimental in Node 22, stable from Node 24). Sessions survive machine
 * restarts and scale past the JSON file's rewrite-every-mutation model.
 *
 * Only the final field values are stored — the JSON-file store and this store
 * are interchangeable backends for the same `SessionStore` contract.
 */
interface Row {
  id: string;
  kind: "task" | "transfer";
  tool: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  ttl_ms: number;
  progress: string | null;
  result: string | null;
  error: string | null;
  cursor: string | null;
  meta: string | null;
}

const jsonOr = <T>(raw: string | null): T | undefined =>
  raw == null ? undefined : (JSON.parse(raw) as T);

const str = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

function toRow(record: SessionRecord): Row {
  return {
    id: record.id,
    kind: record.kind,
    tool: record.tool ?? null,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ttl_ms: record.ttlMs,
    progress: str(record.progress),
    result: str(record.result),
    error: str(record.error),
    cursor: str(record.cursor),
    meta: str(record.meta),
  };
}

function fromRow(row: Row): SessionRecord {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.tool != null ? { tool: row.tool } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ttlMs: row.ttl_ms,
    ...(row.progress != null ? { progress: jsonOr<SessionRecord["progress"]>(row.progress) } : {}),
    ...(row.result != null ? { result: jsonOr<unknown>(row.result) } : {}),
    ...(row.error != null ? { error: jsonOr<SerializedDurableError>(row.error) } : {}),
    ...(row.cursor != null ? { cursor: jsonOr<number | string>(row.cursor) } : {}),
    ...(row.meta != null ? { meta: jsonOr<Record<string, unknown>>(row.meta) } : {}),
  };
}

export class SqliteSessionStore implements SessionStore {
  readonly #db: DatabaseSync;

  constructor(filePath: string) {
    this.#db = new DatabaseSync(filePath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        tool       TEXT,
        status     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ttl_ms     INTEGER NOT NULL,
        progress   TEXT,
        result     TEXT,
        error      TEXT,
        cursor     TEXT,
        meta       TEXT
      )
    `);
  }

  async create(record: SessionRecord): Promise<void> {
    const r = toRow(record);
    this.#db
      .prepare(
        `INSERT INTO sessions (id, kind, tool, status, created_at, updated_at, ttl_ms, progress, result, error, cursor, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.kind, r.tool, r.status, r.created_at, r.updated_at, r.ttl_ms, r.progress, r.result, r.error, r.cursor, r.meta);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  async update(id: string, patch: Partial<Omit<SessionRecord, "id">>): Promise<SessionRecord | null> {
    const current = await this.get(id);
    if (!current) return null;
    const merged: SessionRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const r = toRow(merged);
    this.#db
      .prepare(
        `UPDATE sessions
         SET kind = ?, tool = ?, status = ?, created_at = ?, updated_at = ?, ttl_ms = ?,
             progress = ?, result = ?, error = ?, cursor = ?, meta = ?
         WHERE id = ?`,
      )
      .run(r.kind, r.tool, r.status, r.created_at, r.updated_at, r.ttl_ms, r.progress, r.result, r.error, r.cursor, r.meta, id);
    return merged;
  }

  async delete(id: string): Promise<void> {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async list(filter: { kind?: SessionRecord["kind"]; status?: SessionStatus } = {}): Promise<SessionRecord[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db.prepare(`SELECT * FROM sessions ${where}`).all(...params) as unknown as Row[];
    return rows.map(fromRow);
  }

  /** Close the underlying database handle. */
  close(): void {
    this.#db.close();
  }
}
