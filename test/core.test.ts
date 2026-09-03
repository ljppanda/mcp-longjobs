import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DurableError,
  JsonFileSessionStore,
  MemorySessionStore,
  isExpired,
  isTerminal,
  serializeError,
  sha256Hex,
  type SessionRecord,
} from "../src/core/index.js";
import { isInsideRoot } from "../src/files/path-safety.js";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: "task_test",
    kind: "task",
    status: "working",
    createdAt: now,
    updatedAt: now,
    ttlMs: 60_000,
    ...overrides,
  };
}

describe("session stores", () => {
  it("memory store round-trips create/get/update/delete", async () => {
    const store = new MemorySessionStore();
    await store.create(record());
    expect((await store.get("task_test"))?.status).toBe("working");

    const updated = await store.update("task_test", { status: "completed", result: { ok: 1 } });
    expect(updated?.status).toBe("completed");
    expect(updated!.updatedAt >= updated!.createdAt).toBe(true);
    expect((await store.get("task_test"))?.result).toEqual({ ok: 1 });

    await store.delete("task_test");
    expect(await store.get("task_test")).toBeNull();
  });

  it("json store persists across instances (restart-safe)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longjobs-core-"));
    try {
      const file = join(dir, "state.json");
      const first = new JsonFileSessionStore(file);
      await first.create(record({ id: "task_persist", status: "completed", result: { n: 42 } }));

      const second = new JsonFileSessionStore(file);
      expect((await second.get("task_persist"))?.result).toEqual({ n: 42 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list filters by kind and status", async () => {
    const store = new MemorySessionStore();
    await store.create(record({ id: "task_a", status: "working" }));
    await store.create(record({ id: "file_b", kind: "transfer", status: "completed" }));

    expect((await store.list({ kind: "transfer" })).map((r) => r.id)).toEqual(["file_b"]);
    expect((await store.list({ status: "completed" })).map((r) => r.id)).toEqual(["file_b"]);
  });
});

describe("error envelope", () => {
  it("DurableError round-trips its fields", () => {
    const json = serializeError(
      new DurableError({
        code: "offset_mismatch",
        message: "expected 10, got 0",
        retryable: true,
        recoveryHint: "Resend from offset 10",
        partial: { cursor: 10 },
      }),
    );
    expect(json.code).toBe("offset_mismatch");
    expect(json.retryable).toBe(true);
    expect(json.recoveryHint).toBe("Resend from offset 10");
    expect(json.partial?.cursor).toBe(10);
  });

  it("unknown errors become non-retryable internal_error", () => {
    const json = serializeError(new Error("boom"));
    expect(json.code).toBe("internal_error");
    expect(json.retryable).toBe(false);
    expect(json.message).toBe("boom");
  });
});

describe("misc core", () => {
  it("sha256 matches the known test vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("terminal statuses are detected", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("working")).toBe(false);
    expect(isTerminal("input_required")).toBe(false);
  });

  it("isExpired only flags non-terminal sessions past their ttl", () => {
    const now = Date.now();
    const stale = record({ createdAt: new Date(now - 10_000).toISOString(), ttlMs: 1_000 });
    expect(isExpired(stale, now)).toBe(true);
    const fresh = record({ createdAt: new Date(now - 500).toISOString(), ttlMs: 1_000 });
    expect(isExpired(fresh, now)).toBe(false);
    // Terminal sessions never expire, however old.
    const oldDone = record({ status: "completed", createdAt: new Date(now - 3_600_000).toISOString(), ttlMs: 1_000 });
    expect(isExpired(oldDone, now)).toBe(false);
  });

  it("isInsideRoot blocks path traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "longjobs-roots-"));
    try {
      expect(isInsideRoot(root, join(root, "sub", "file.txt"))).toBe(true);
      expect(isInsideRoot(root, root)).toBe(true);
      expect(isInsideRoot(root, join(root, "..", "elsewhere"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
