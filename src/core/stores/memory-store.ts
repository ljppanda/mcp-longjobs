import type { SessionRecord, SessionStatus, SessionStore } from "../session.js";

/**
 * In-memory store. Sessions survive client restarts within one server process
 * only — pair with a disk-backed store when durability across server restarts
 * matters (that is the whole point of durable handles).
 */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();

  async create(record: SessionRecord): Promise<void> {
    this.#sessions.set(record.id, structuredClone(record));
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
    return structuredClone(record);
  }

  async delete(id: string): Promise<void> {
    this.#sessions.delete(id);
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
}
