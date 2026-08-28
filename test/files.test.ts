import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySessionStore, sha256Hex } from "../src/core/index.js";
import { withFileTransfer } from "../src/files/with-file-transfer.js";
import { FakeRegistrar, structured } from "./helpers.js";

describe("file transfer facade", () => {
  let dir: string;
  let fake: FakeRegistrar;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "longjobs-files-"));
    fake = new FakeRegistrar();
    withFileTransfer(fake, {
      store: new MemorySessionStore(),
      storageDir: join(dir, "storage"),
      allowedRoots: [dir],
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uploads in chunks, enforces the offset cursor, commits with checksum", async () => {
    const payload = Buffer.from("hello durable world");
    const open = structured(
      await fake.invoke("file_transfer_open", {
        direction: "upload",
        path: join(dir, "out", "hello.txt"),
        size: payload.length,
        sha256: sha256Hex(payload),
      }),
    );
    expect(open.nextOffset).toBe(0);
    expect(open.chunkSize).toBeGreaterThan(0);

    const half = Math.ceil(payload.length / 2);
    const w1 = structured(
      await fake.invoke("file_transfer_write", {
        handle: open.handle,
        offset: 0,
        data: payload.subarray(0, half).toString("base64"),
      }),
    );
    expect(w1.nextOffset).toBe(half);

    // A stale/duplicated chunk is a repairable envelope, not a thrown error.
    const bad = structured(
      await fake.invoke("file_transfer_write", {
        handle: open.handle,
        offset: 0,
        data: payload.subarray(0, 1).toString("base64"),
      }),
    );
    expect(bad.error.code).toBe("offset_mismatch");
    expect(bad.error.retryable).toBe(true);
    expect(bad.error.partial.cursor).toBe(half);

    await fake.invoke("file_transfer_write", {
      handle: open.handle,
      offset: half,
      data: payload.subarray(half).toString("base64"),
    });

    const commit = structured(await fake.invoke("file_transfer_commit", { handle: open.handle }));
    expect(commit.status).toBe("completed");
    expect(commit.sha256).toBe(sha256Hex(payload));
    expect(readFileSync(join(dir, "out", "hello.txt"))).toEqual(payload);
  });

  it("detects checksum mismatch with a repairable envelope", async () => {
    const open = structured(
      await fake.invoke("file_transfer_open", {
        direction: "upload",
        path: join(dir, "bad.bin"),
        sha256: "0".repeat(64),
      }),
    );
    await fake.invoke("file_transfer_write", {
      handle: open.handle,
      offset: 0,
      data: Buffer.from("actual bytes").toString("base64"),
    });
    const commit = structured(await fake.invoke("file_transfer_commit", { handle: open.handle }));
    expect(commit.status).toBe("failed");
    expect(commit.error.code).toBe("checksum_mismatch");
  });

  it("downloads in chunks and reports eof with the whole-file sha256", async () => {
    const small = new FakeRegistrar();
    withFileTransfer(small, {
      store: new MemorySessionStore(),
      storageDir: join(dir, "storage-small"),
      allowedRoots: [dir],
      chunkSize: 100, // force multiple chunks
    });

    const data = Buffer.alloc(350, 7);
    const src = join(dir, "video.bin");
    writeFileSync(src, data);

    const open = structured(await small.invoke("file_transfer_open", { direction: "download", path: src }));
    let offset: number = open.nextOffset;
    let eof = false;
    let sha256: string | undefined;
    const chunks: Buffer[] = [];
    let guard = 0;

    while (!eof && guard < 100) {
      const read = structured(await small.invoke("file_transfer_read", { handle: open.handle, offset }));
      chunks.push(Buffer.from(read.data, "base64"));
      eof = read.eof;
      offset = read.nextOffset;
      if (read.sha256) sha256 = read.sha256;
      guard += 1;
    }

    expect(Buffer.concat(chunks)).toEqual(data);
    expect(sha256).toBe(createHash("sha256").update(data).digest("hex"));
  });

  it("rejects paths outside the allowed roots", async () => {
    const res = structured(
      await fake.invoke("file_transfer_open", {
        direction: "download",
        path: "C:\\Windows\\system32\\config.sam",
      }),
    );
    expect(res.error.code).toBe("invalid_param");
    expect(res.error.param).toBe("path");
  });
});
