import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRecord, SessionStatus, SessionStore } from "../session.js";

/**
 * Zero-dependency durable store: one JSON file, written atomically
 * (tmp file + rename) after every mutation. Sessions survive server
 * restarts, which is what makes "resume after client restart" real.
 */
export class JsonFileSessionStore implements SessionStore {
  readonly #file: string;
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(filePath: string) {
    this.#file = filePath;
    if (existsSync(filePath)) {
      try {
        const records = JSON.parse(readFileSync(filePath, "utf8")) as SessionRecord[];
        for (const record of records) this.#sessions.set(record.id, record);
      } catch {
        // Corrupt state file: start empty rather than crash the server.
      }
    }
  }

  async create(record: SessionRecord): Promise<void> {
    this.#sessions.set(record.id, structuredClone(record));
    this.#flush();
  }

  async get(id: string): Promise<SessionRecord | null> {
    const record = this.#sessions.get(id);
    return record ? structuredClone(record) : null;
  }

  async update(
    id: string,
    patch: Partial<Omit<SessionRecord, "id">>,
  ): Promise<SessionRecord | null> {
    const record = this.#sessions.get(id);
    if (!record) return null;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    this.#flush();
    return structuredClone(record);
  }

  async delete(id: string): Promise<void> {
    this.#sessions.delete(id);
    this.#flush();
  }

  async list(
    filter: { kind?: SessionRecord["kind"]; status?: SessionStatus } = {},
  ): Promise<SessionRecord[]> {
    return [...this.#sessions.values()].filter(
      (r) =>
        (filter.kind === undefined || r.kind === filter.kind) &&
        (filter.status === undefined || r.status === filter.status),
    );
  }

  #flush(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.#sessions.values()], null, 2));
    try {
      unlinkSync(this.#file);
    } catch {
      // First write: nothing to replace yet.
    }
    renameSync(tmp, this.#file);
  }
}
