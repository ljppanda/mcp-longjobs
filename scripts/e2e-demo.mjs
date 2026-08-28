#!/usr/bin/env node
/**
 * End-to-end demo against the REAL SDK stack: a Client (stdio transport)
 * drives the report-generator server through a full durable-task lifecycle
 * and a chunked file transfer, just like a user's MCP host would.
 *
 *   npm run build && npm run demo
 *
 * Expected output: a task that starts instantly, reports progress across
 * several polls, completes with a result, then an upload that is verified
 * by size and sha256 at commit.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = join(process.cwd(), "state");
const call = (client, name, args) =>
  client.callTool({ name, arguments: args }).then((r) => JSON.parse(r.content[0].text));

function assert(cond, msg) {
  if (!cond) throw new Error(`E2E FAILED: ${msg}`);
}

const client = new Client({ name: "e2e-demo", version: "0.0.1" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/examples/report-generator.js"] }));

// --- 1. Durable task: instant handle, progress polling, completed result ---
console.log("> calling generate-report (sections=2, ~4s of work)...");
const start = await call(client, "generate-report", { topic: "EV batteries", sections: 2 });
assert(start.status === "working", `expected instant working handle, got ${start.status}`);
console.log(`  taskId: ${start.taskId} (returned immediately, no timeout)`);

let polled = 0;
let done;
for (;;) {
  await sleep(1_000);
  done = await call(client, "durable_task_get", { taskId: start.taskId });
  polled += 1;
  const progress = done.progress?.message ?? done.status;
  console.log(`  poll ${polled}: ${done.status}${progress ? ` — ${progress}` : ""}`);
  if (done.status !== "working" && done.status !== "input_required") break;
}
assert(done.status === "completed", `expected completed, got ${done.status}`);
assert(done.result.summary.includes("EV batteries"), "result should contain the topic summary");

// --- 2. Chunked upload with offset cursor + sha256 verification at commit ---
const payload = Buffer.from("e2e upload payload — resumable across restarts");
const sha = createHash("sha256").update(payload).digest("hex");
const dest = join(state, "e2e-upload.bin");
const opened = await call(client, "file_transfer_open", {
  direction: "upload",
  path: dest,
  size: payload.length,
  sha256: sha,
});
assert(opened.nextOffset === 0, "upload should start at offset 0");

const half = Math.ceil(payload.length / 2);
await call(client, "file_transfer_write", {
  handle: opened.handle,
  offset: 0,
  data: payload.subarray(0, half).toString("base64"),
});
const second = await call(client, "file_transfer_write", {
  handle: opened.handle,
  offset: half,
  data: payload.subarray(half).toString("base64"),
});
assert(second.nextOffset === payload.length, "cursor should reach the full size");
const committed = await call(client, "file_transfer_commit", { handle: opened.handle });
assert(committed.status === "completed", `commit expected completed, got ${committed.status}`);
assert(existsSync(dest) && readFileSync(dest).equals(payload), "uploaded bytes must match");

// --- 3. Chunked download back, with whole-file sha256 at eof ---
const dl = await call(client, "file_transfer_open", { direction: "download", path: dest });
let offset = 0, eof = false, collected = Buffer.alloc(0), gotSha;
while (!eof) {
  const chunk = await call(client, "file_transfer_read", { handle: dl.handle, offset });
  collected = Buffer.concat([collected, Buffer.from(chunk.data, "base64")]);
  offset = chunk.nextOffset;
  eof = chunk.eof;
  if (chunk.sha256) gotSha = chunk.sha256;
}
assert(collected.equals(payload), "download must round-trip the bytes");
assert(gotSha === sha, "download sha256 must match the upload checksum");

console.log("\nE2E PASS: durable task lifecycle + chunked upload/download with checksums");
await client.close();
process.exit(0);
