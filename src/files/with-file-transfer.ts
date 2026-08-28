import { z } from "zod";
import {
  createHash,
} from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  MemorySessionStore,
  newId,
  textResult,
  type SessionRecord,
  type SessionStore,
  type ToolRegistrar,
} from "../core/index.js";
import { isInsideRoot } from "./path-safety.js";

const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface WithFileTransferOptions {
  /** Defaults to MemorySessionStore; use JsonFileSessionStore for resumable-across-restart transfers. */
  store?: SessionStore;
  /** Directory for staged uploads (also the default allowed root). */
  storageDir: string;
  /** Chunk size in bytes. Default 256 KiB — small enough that a base64 chunk never dominates a model context. */
  chunkSize?: number;
  /** Server-side roots the tools may read from and write to. Defaults to [storageDir]. */
  allowedRoots?: string[];
  /** Refuse to open downloads larger than this. Default 2 GiB. */
  maxFileSize?: number;
}

/**
 * Register resumable, chunked file-transfer tools on a registrar:
 *
 *   file_transfer_open    open an upload or download session, get chunk size + next offset
 *   file_transfer_write   append one base64 chunk at the expected offset (enforces resume cursor)
 *   file_transfer_read    read one chunk (byte range), returns eof + whole-file sha256 at the end
 *   file_transfer_commit  verify size + sha256, move the staged file into place
 *   file_transfer_status  inspect a session (survives server restarts with a durable store)
 *
 * Design rule: the model is the director, not the courier. Chunks are for
 * small-to-medium payloads that genuinely must flow through tool calls; for
 * large files, open a session and move bytes out-of-band (TUS endpoint is
 * planned), then let the model verify the checksum.
 */
export function withFileTransfer(
  registrar: ToolRegistrar,
  options: WithFileTransferOptions,
): void {
  const store = options.store ?? new MemorySessionStore();
  const chunkSize = options.chunkSize ?? 256 * 1024;
  const maxFileSize = options.maxFileSize ?? 2 * 1024 ** 3;
  const roots = (options.allowedRoots ?? [options.storageDir]).map((r) => resolve(r));
  const stagingDir = join(resolve(options.storageDir), "staging");
  mkdirSync(stagingDir, { recursive: true });

  // Incremental hashers per active upload. After a server restart the hasher
  // is rebuilt from the staged bytes, so resume produces a correct checksum.
  const hashers = new Map<string, ReturnType<typeof createHash>>();

  const inRoots = (p: string): boolean => roots.some((root) => isInsideRoot(root, p));
  const iso = (): string => new Date().toISOString();
  const envelopeError = (error: Record<string, unknown>) => textResult({ error });

  function unknownHandle(handle: string) {
    return envelopeError({
      code: "unknown_transfer",
      message: `No transfer session with id ${handle}.`,
      retryable: false,
      recoveryHint: "The handle may be mistyped or expired. Ask the user whether to open a new transfer.",
    });
  }

  async function hashFile(path: string): Promise<string> {
    const h = createHash("sha256");
    const stream = createReadStream(path);
    for await (const chunk of stream) h.update(chunk);
    return h.digest("hex");
  }

  async function hasherFor(rec: SessionRecord) {
    const existing = hashers.get(rec.id);
    if (existing) return existing;
    const h = createHash("sha256");
    const staging = rec.meta?.["stagingPath"] as string | undefined;
    const received = typeof rec.cursor === "number" ? rec.cursor : 0;
    if (staging && received > 0 && existsSync(staging)) {
      const stream = createReadStream(staging);
      for await (const chunk of stream) h.update(chunk);
    }
    hashers.set(rec.id, h);
    return h;
  }

  registrar.registerTool("file_transfer_open", {
    title: "Open a resumable file transfer",
    description:
      "Open a chunked upload or download session. Upload: send chunks with file_transfer_write starting at offset 0, then file_transfer_commit. Download: fetch chunks with file_transfer_read until eof. Sessions survive server restarts — resume at the reported nextOffset.",
    inputSchema: {
      direction: z.enum(["upload", "download"]),
      path: z.string().describe("Server-side destination (upload) or source (download) path."),
      size: z.number().int().positive().optional().describe("Upload: expected byte size, verified at commit."),
      sha256: z.string().optional().describe("Upload: expected hex sha256, verified at commit."),
    },
  }, async (args: unknown) => {
    const a = args as { direction: "upload" | "download"; path: string; size?: number; sha256?: string };
    if (!inRoots(a.path)) {
      return envelopeError({
        code: "invalid_param",
        message: `Path ${a.path} is outside the allowed roots.`,
        retryable: false,
        param: "path",
        recoveryHint: `Use a path inside one of the allowed roots: ${roots.join(", ")}`,
      });
    }

    const id = newId("file");
    const now = iso();

    if (a.direction === "download") {
      if (!existsSync(a.path)) {
        return envelopeError({
          code: "not_found",
          message: `No file at ${a.path}.`,
          retryable: false,
          param: "path",
        });
      }
      const size = statSync(a.path).size;
      if (size > maxFileSize) {
        return envelopeError({
          code: "file_too_large",
          message: `File is ${size} bytes; the model-chunk limit is ${maxFileSize}.`,
          retryable: false,
          recoveryHint: "Serve this file over HTTP (e.g. a TUS endpoint) instead of model-driven chunks.",
        });
      }
      await store.create({
        id,
        kind: "transfer",
        status: "working",
        createdAt: now,
        updatedAt: now,
        ttlMs: TRANSFER_TTL_MS,
        cursor: 0,
        meta: { direction: "download", path: a.path, size },
      });
      return textResult({
        handle: id,
        direction: "download",
        size,
        chunkSize,
        nextOffset: 0,
        readWith: "file_transfer_read",
      });
    }

    const stagingPath = join(stagingDir, `${id}.part`);
    await store.create({
      id,
      kind: "transfer",
      status: "working",
      createdAt: now,
      updatedAt: now,
      ttlMs: TRANSFER_TTL_MS,
      cursor: 0,
      meta: {
        direction: "upload",
        path: a.path,
        stagingPath,
        size: a.size ?? null,
        sha256: a.sha256 ?? null,
      },
    });
    return textResult({
      handle: id,
      direction: "upload",
      chunkSize,
      nextOffset: 0,
      writeWith: "file_transfer_write",
      commitWith: "file_transfer_commit",
    });
  });

  registrar.registerTool("file_transfer_write", {
    title: "Write one chunk to an upload session",
    description: "Append a base64 chunk at the session's expected offset. A wrong offset returns a repairable error with the correct cursor instead of failing the transfer.",
    inputSchema: {
      handle: z.string(),
      offset: z.number().int().min(0),
      data: z.string().describe("Base64-encoded chunk (<= the session's chunkSize)."),
    },
  }, async (args: unknown) => {
    const a = args as { handle: string; offset: number; data: string };
    const rec = await store.get(a.handle);
    if (!rec || rec.kind !== "transfer" || rec.meta?.["direction"] !== "upload") {
      return unknownHandle(a.handle);
    }
    if (rec.status !== "working") {
      return envelopeError({
        code: "not_active",
        message: `Transfer is ${rec.status}.`,
        retryable: false,
      });
    }
    const cursor = typeof rec.cursor === "number" ? rec.cursor : 0;
    if (a.offset !== cursor) {
      // The whole point of the cursor: the model repairs in one round-trip.
      return envelopeError({
        code: "offset_mismatch",
        message: `Expected offset ${cursor}, got ${a.offset}.`,
        retryable: true,
        partial: { cursor },
        recoveryHint: `Do NOT resend the whole file. Re-send this chunk starting at offset ${cursor}.`,
      });
    }
    const buf = Buffer.from(a.data, "base64");
    if (buf.length > chunkSize) {
      return envelopeError({
        code: "chunk_too_large",
        message: `Chunk is ${buf.length} bytes; the limit is ${chunkSize}.`,
        retryable: true,
        partial: { cursor },
        recoveryHint: `Split the chunk and retry at offset ${cursor}.`,
      });
    }
    appendFileSync(rec.meta!["stagingPath"] as string, buf);
    const h = await hasherFor(rec);
    h.update(buf);
    const next = cursor + buf.length;
    await store.update(a.handle, { cursor: next });
    return textResult({ handle: a.handle, received: next, nextOffset: next });
  });

  registrar.registerTool("file_transfer_read", {
    title: "Read one chunk from a download session",
    description: "Fetch a byte range as base64. Repeat with nextOffset until eof; the final response carries the whole-file sha256.",
    inputSchema: {
      handle: z.string(),
      offset: z.number().int().min(0).optional().describe("Defaults to the session's resume cursor."),
      length: z.number().int().min(1).optional().describe("Defaults to the session's chunkSize."),
    },
  }, async (args: unknown) => {
    const a = args as { handle: string; offset?: number; length?: number };
    const rec = await store.get(a.handle);
    if (!rec || rec.kind !== "transfer" || rec.meta?.["direction"] !== "download") {
      return unknownHandle(a.handle);
    }
    const path = rec.meta!["path"] as string;
    const size = statSync(path).size;
    const offset = Math.min(a.offset ?? (typeof rec.cursor === "number" ? rec.cursor : 0), size);
    const length = Math.max(0, Math.min(a.length ?? chunkSize, chunkSize, size - offset));

    if (length === 0) {
      return textResult({ handle: a.handle, eof: true, size, sha256: await hashFile(path), data: "" });
    }

    const buf = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, length, offset);
    } finally {
      closeSync(fd);
    }
    const nextOffset = offset + length;
    await store.update(a.handle, { cursor: nextOffset });
    const eof = nextOffset >= size;
    return textResult({
      handle: a.handle,
      data: buf.toString("base64"),
      bytes: length,
      offset,
      nextOffset,
      eof,
      ...(eof ? { sha256: await hashFile(path) } : {}),
    });
  });

  registrar.registerTool("file_transfer_commit", {
    title: "Finalize an upload session",
    description: "Verify size and sha256 (when declared), then move the staged file to its destination.",
    inputSchema: { handle: z.string() },
  }, async (args: unknown) => {
    const { handle } = args as { handle: string };
    const rec = await store.get(handle);
    if (!rec || rec.kind !== "transfer" || rec.meta?.["direction"] !== "upload") {
      return unknownHandle(handle);
    }
    if (rec.status !== "working") {
      return textResult({ handle, status: rec.status });
    }

    const staging = rec.meta!["stagingPath"] as string;
    const destination = rec.meta!["path"] as string;
    const received = typeof rec.cursor === "number" ? rec.cursor : 0;
    const expectedSize = rec.meta!["size"] as number | null;
    const expectedSha = rec.meta!["sha256"] as string | null;

    if (expectedSize != null && received !== expectedSize) {
      const error = {
        code: "size_mismatch",
        message: `Expected ${expectedSize} bytes, received ${received}.`,
        retryable: true,
        recoveryHint: `Continue uploading from offset ${received}.`,
        partial: { cursor: received },
      };
      await store.update(handle, { status: "failed", error });
      return textResult({ handle, status: "failed", error });
    }

    const h = await hasherFor(rec);
    const actualSha = h.digest("hex");
    if (expectedSha && actualSha !== expectedSha) {
      try { unlinkSync(staging); } catch { /* already gone */ }
      hashers.delete(handle);
      const error = {
        code: "checksum_mismatch",
        message: `sha256 mismatch: expected ${expectedSha}, got ${actualSha}.`,
        retryable: true,
        recoveryHint: "Re-open the upload and send the file again; a fresh session replaces the discarded staging file.",
        partial: { cursor: 0 },
      };
      await store.update(handle, { status: "failed", error });
      return textResult({ handle, status: "failed", error });
    }

    mkdirSync(dirname(destination), { recursive: true });
    try { unlinkSync(destination); } catch { /* destination did not exist */ }
    renameSync(staging, destination);
    hashers.delete(handle);
    await store.update(handle, {
      status: "completed",
      result: { path: destination, size: received, sha256: actualSha },
    });
    return textResult({ handle, status: "completed", path: destination, size: received, sha256: actualSha });
  });

  registrar.registerTool("file_transfer_status", {
    title: "Inspect a transfer session",
    description: "Report direction, status, bytes received so far, and destination — useful after a restart.",
    inputSchema: { handle: z.string() },
  }, async (args: unknown) => {
    const { handle } = args as { handle: string };
    const rec = await store.get(handle);
    if (!rec) return unknownHandle(handle);
    return textResult({
      handle,
      status: rec.status,
      direction: rec.meta?.["direction"] ?? null,
      received: typeof rec.cursor === "number" ? rec.cursor : 0,
      size: rec.meta?.["size"] ?? null,
      path: rec.meta?.["path"] ?? null,
      startedAt: rec.createdAt,
    });
  });
}
