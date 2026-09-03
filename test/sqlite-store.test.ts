import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DurableError,
  SqliteSessionStore,
  type SessionRecord,
} from "../src/core/index.js";

// node:sqlite does not exist on Node < 22.13 (CI still runs Node 20); the
// store lazy-loads it, and this suite skips there instead of failing.
let sqliteAvailable = false;
try {
  await import("node:sqlite");
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

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

describe.skipIf(!sqliteAvailable)("sqlite session store", () => {
  it("round-trips all field shapes (progress/result/error/cursor/meta)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longjobs-sqlite-"));
    const file = join(dir, "state.db");
    const store = new SqliteSessionStore(file);
    try {
      await store.create(
        record({
          id: "task_full",
          kind: "task",
          status: "input_required",
          progress: { message: "half", fraction: 0.5 },
          meta: { question: { prompt: "continue?" } },
        }),
      );
      await store.create(
        record({
          id: "file_num",
          kind: "transfer",
          status: "completed",
          result: { path: "C:\\x", size: 42, sha256: "abc" },
          cursor: 131072,
          error: new DurableError({ code: "x", message: "y", retryable: true }).toJSON(),
        }),
      );
      await store.create(record({ id: "file_str", kind: "transfer", cursor: "token-abc" }));

      const full = await store.get("task_full");
      expect(full?.status).toBe("input_required");
      expect(full?.progress).toEqual({ message: "half", fraction: 0.5 });
      expect(full?.meta).toEqual({ question: { prompt: "continue?" } });

      const num = await store.get("file_num");
      expect(num?.cursor).toBe(131072);
      expect(num?.result).toEqual({ path: "C:\\x", size: 42, sha256: "abc" });
      expect(num?.error?.code).toBe("x");

      const s = await store.get("file_str");
      expect(s?.cursor).toBe("token-abc");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("update merges like the other stores and bumps updatedAt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longjobs-sqlite-"));
    const file = join(dir, "state.db");
    const store = new SqliteSessionStore(file);
    try {
      await store.create(record());
      const updated = await store.update("task_test", { status: "completed", result: { ok: 1 } });
      expect(updated?.status).toBe("completed");
      expect(updated?.result).toEqual({ ok: 1 });
      expect(updated!.updatedAt >= updated!.createdAt).toBe(true);
      expect((await store.get("task_test"))?.result).toEqual({ ok: 1 });
      expect(await store.update("task_missing", { status: "failed" })).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists across store instances (same file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longjobs-sqlite-"));
    const file = join(dir, "state.db");
    const first = new SqliteSessionStore(file);
    await first.create(record({ id: "task_persist", status: "failed", error: { code: "boom", message: "b", retryable: false } }));
    first.close();

    const second = new SqliteSessionStore(file);
    try {
      expect((await second.get("task_persist"))?.error?.code).toBe("boom");
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list filters by kind and status; delete removes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longjobs-sqlite-"));
    const file = join(dir, "state.db");
    const store = new SqliteSessionStore(file);
    try {
      await store.create(record({ id: "task_a", status: "working" }));
      await store.create(record({ id: "file_b", kind: "transfer", status: "completed" }));

      expect((await store.list({ kind: "transfer" })).map((r) => r.id)).toEqual(["file_b"]);
      expect((await store.list({ status: "completed" })).map((r) => r.id)).toEqual(["file_b"]);
      expect((await store.list()).length).toBe(2);

      await store.delete("file_b");
      expect(await store.get("file_b")).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
