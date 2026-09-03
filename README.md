# mcp-longjobs

**Durable, resumable operations for MCP — long-running tasks and large files that survive timeouts, disconnects, and client restarts. On every client, today.**

[![CI](https://github.com/ljppanda/mcp-longjobs/actions/workflows/ci.yml/badge.svg)](https://github.com/ljppanda/mcp-longjobs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-longjobs)](https://www.npmjs.com/package/mcp-longjobs)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[中文文档](./README.zh-CN.md)

## The problem

Three things break every MCP server that does real work:

- **Long-running tool calls time out.** Clients impose per-call timeouts (often 10–60s). A crawl, a build, a batch job fails — and the model's "retry" restarts the whole operation from scratch.
- **Failures are unrepairable.** A failed call returns a freeform error, so the model guesses: retry blindly, or give up. It can't fix one parameter and resume.
- **Large files have no transfer story.** Binary content is base64-in-JSON (33% overhead, hard message-size caps) or a bare URL with zero conventions — no chunking, no resume, no integrity checks.

The [2026-07-28 MCP spec](https://modelcontextprotocol.io/specification/2026-07-28) added [Tasks](https://modelcontextprotocol.io/extensions/tasks/overview) — async execution with mid-flight input and durable handles. But [no client supports it yet](https://modelcontextprotocol.io/extensions/client-matrix), and the spec requires servers to refuse tasks for clients that didn't opt in. **Every long-running server therefore needs a fallback path that works on today's clients. That is this package.**

## What you get

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JsonFileSessionStore, withTasks, withFileTransfer, asToolRegistrar } from "mcp-longjobs";

const mcp = new McpServer({ name: "my-server", version: "1.0.0" });
const registrar = asToolRegistrar(mcp);
const store = new JsonFileSessionStore("./state/sessions.json");

const tasks = withTasks(registrar, { store });

tasks.taskTool("crawl-site", {
  description: "Crawl a site and produce a report (takes minutes)",
  inputSchema: { url: z.string(), maxPages: z.number().default(50) },
}, async (args, ctx) => {
  for (const page of pages) {
    if (ctx.signal.aborted) throw new Error("cancelled");
    await ctx.progress(`Crawled ${page.url}`, done / total);

    if (needsConfirmation(page)) {
      const answer = await ctx.needInput({ prompt: `Include ${page.url}?`, choices: ["yes", "no"] });
      if (answer === "no") continue;
    }
  }
  return { summary, reportPath }; // small result for the model; big artifacts go through file transfer
});

withFileTransfer(registrar, { store, storageDir: "./state/blobs" });
```

What the model experiences on **today's clients** (no Tasks support required):

1. `crawl-site` returns **instantly** with a `taskId` and instructions to poll `durable_task_get` — no more timeouts.
2. Polls show live progress: `{ "status": "working", "progress": { "message": "Crawled /pricing", "fraction": 0.4 } }`.
3. Mid-flight questions pause the task as `input_required`; the model answers via `durable_task_respond` and the task continues where it stopped.
4. **Client crash? New session?** `durable_task_get` with the same `taskId` still works — state lives in the store, not in the connection.
5. `durable_task_cancel` aborts the work cooperatively at its next checkpoint.

Failures are **data, not protocol errors** — a structured envelope the model can repair in one round-trip:

```json
{
  "status": "failed",
  "error": {
    "code": "offset_mismatch",
    "message": "Expected offset 131072, got 0.",
    "retryable": true,
    "recoveryHint": "Do NOT resend the whole file. Re-send this chunk starting at offset 131072.",
    "partial": { "cursor": 131072 }
  }
}
```

## Packages (subpath exports)

| Import | Purpose |
| --- | --- |
| `mcp-longjobs/tasks` | `withTasks()` + the `durable_task_*` facade: background execution, progress, mid-flight input, cooperative cancellation |
| `mcp-longjobs/files` | `withFileTransfer()`: chunked upload/download, resume cursor, sha256 verification, path-safety roots |
| `mcp-longjobs/core` | Session model, pluggable stores (memory, JSON file), structured error envelope |

## Design notes

- **Bytes never flow through the model.** The model sees metadata only: handle, size, sha256, progress. Chunks through tool calls are for small-to-medium payloads; large files should move out-of-band (TUS endpoint planned) with the model verifying integrity.
- **The model is the director, not the courier.** Facade tool results carry their own instructions ("call `durable_task_get` with this id", "resume at offset N"), so any capable model can drive the protocol with zero host-side support.
- **Failures are repairable data.** Every failure carries `code`, `retryable`, `recoveryHint`, and `partial.cursor` — what went wrong, whether a retry can work, what to do instead, and what already succeeded.
- **Lifecycle vocabulary matches the spec.** `working / input_required / completed / failed / cancelled`, so the native adapter can slot in later without breaking changes.

## Status

| Component | Status |
| --- | --- |
| Tasks fallback facade (progress / input / cancel) | ✅ implemented |
| Durable session stores (memory, JSON file, SQLite) | ✅ implemented |
| Session TTL expiry (lazy, repairable envelope) | ✅ implemented |
| Chunked file transfer with resume + checksums | ✅ implemented |
| Native ext-tasks adapter (`CreateTaskResult` / `tasks/get`) | 🔜 tracks the SDK's experimental Tasks API |
| TUS 1.0 out-of-band endpoint for large files | 🔜 planned — see [mcp#189](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/189) |
| Redis store, Python port | 🔜 planned |

## Quickstart

```bash
git clone https://github.com/ljppanda/mcp-longjobs
cd mcp-longjobs
npm install && npm run build
node dist/examples/report-generator.js
```

(Once published to npm, the same server runs with a single command: `npx mcp-longjobs`.)

Point your client at it (stdio):

```json
{
  "mcpServers": {
    "report-generator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-longjobs/dist/examples/report-generator.js"]
    }
  }
}
```

Then ask: *"Generate a report on EV batteries with 3 sections."* Watch the model start the job, poll `durable_task_get`, and pick up the result. Kill the client mid-run, restart it, and ask for the same taskId — it resumes.

## Development

```bash
npm install
npm test         # vitest
npm run build    # tsc -> dist/
npm run example  # build + run the demo server
```

## Contributing

PRs welcome — especially: store backends (SQLite/Redis), the native ext-tasks adapter, and the TUS endpoint. Please open an issue first for anything larger.

## License

[MIT](./LICENSE)
