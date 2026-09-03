import type { DatabaseSync } from "node:sqlite";
import type { SerializedDurableError } from "../errors.js";
import type { SessionRecord, SessionStatus, SessionStore } from "../session.js";

/**
 * SQLite-backed store using Node's built-in `node:sqlite` (zero dependencies).
 *
 * Availability: `node:sqlite` exists from Node 22.13 (flagged in earlier 22.x)
 * and is stable in Node 24. On older runtimes (e.g. Node 20) the module is
 * loaded lazily and only throws when this store is actually constructed, so
 * the rest of the library keeps working — swap in the JSON-file store there.
 *
 * Only the final field values are stored — this store and the JSON-file store
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
  readonly #file: string;
  #db: DatabaseSync | null = null;
  #loadError: Error | null = null;

  constructor(filePath: string) {
    this.#file = filePath;
  }

  /**
   * Lazily import node:sqlite so this module loads on runtimes without it
   * (Node < 22.13). Every public method is async, so opening on first use is
   * free. The failure is cached and rethrown with a descriptive message.
   */
  async #ensureDb(): Promise<DatabaseSync> {
    if (this.#db) return this.#db;
    if (this.#loadError) throw this.#loadError;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(this.#file);
      db.exec(`
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
      this.#db = db;
      return db;
    } catch (cause) {
      this.#loadError = new Error(
        "SqliteSessionStore requires node:sqlite, which is unavailable in this Node version " +
          `(got ${process.version}; need >= 22.13, stable in 24). Use JsonFileSessionStore or MemorySessionStore instead.`,
        { cause },
      );
      throw this.#loadError;
    }
  }

  async create(record: SessionRecord): Promise<void> {
    const db = await this.#ensureDb();
    const r = toRow(record);
    db.prepare(
      `INSERT INTO sessions (id, kind, tool, status, created_at, updated_at, ttl_ms, progress, result, error, cursor, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.kind, r.tool, r.status, r.created_at, r.updated_at, r.ttl_ms, r.progress, r.result, r.error, r.cursor, r.meta);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const db = await this.#ensureDb();
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
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
    const db = await this.#ensureDb();
    const r = toRow(merged);
    db.prepare(
      `UPDATE sessions
       SET kind = ?, tool = ?, status = ?, created_at = ?, updated_at = ?, ttl_ms = ?,
           progress = ?, result = ?, error = ?, cursor = ?, meta = ?
       WHERE id = ?`,
    ).run(r.kind, r.tool, r.status, r.created_at, r.updated_at, r.ttl_ms, r.progress, r.result, r.error, r.cursor, r.meta, id);
    return merged;
  }

  async delete(id: string): Promise<void> {
    const db = await this.#ensureDb();
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async list(filter: { kind?: SessionRecord["kind"]; status?: SessionStatus } = {}): Promise<SessionRecord[]> {
    const db = await this.#ensureDb();
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
    const rows = db.prepare(`SELECT * FROM sessions ${where}`).all(...params) as unknown as Row[];
    return rows.map(fromRow);
  }

  /** Close the underlying database handle, if it was ever opened. */
  close(): void {
    this.#db?.close();
    this.#db = null;
  }
}
