# r/mcp 发布草稿

## 标题选项

- [P] mcp-longjobs: durable tasks + resumable file transfers for MCP servers — works on every client today
- [P] The Tasks extension shipped in the spec a month ago. Zero clients support it. Here's the fallback library.

## 正文（self-text）

The 2026-07-28 spec added the Tasks extension (async execution, durable handles, mid-flight input), but the [client matrix](https://modelcontextprotocol.io/extensions/client-matrix) is still empty for it — and the spec requires servers to refuse task results for clients that didn't opt in. Long-running tool calls keep timing out at the client's limit, and "retry" restarts the whole operation.

I built the missing layer as a library for server authors:

- **`withTasks()`**: wrap your slow tool, get an instant `taskId` + generated `durable_task_get/respond/cancel` facade tools. Model polls progress, answers mid-flight questions, cancels cooperatively. State persists in a JSON-file store, so taskIds survive client restarts. Lifecycle states mirror the spec vocabulary so a native adapter drops in later.
- **`withFileTransfer()`**: chunked up/download with a resume cursor, offset enforcement (wrong offset → repairable envelope with `partial.cursor`, not a thrown error), sha256 verification at commit. Path-safety roots included.
- **Structured errors everywhere**: every failure carries `code / retryable / recoveryHint / partial` — the model repairs in one round-trip instead of guessing.

Design rule: bytes never go through the model context; the model directs (handles, sizes, checksums), an out-of-band path moves the bytes (TUS endpoint planned, aligned with the official File Uploads WG).

Repo: https://github.com/ljppanda/mcp-longjobs (MIT, 17 tests, E2E demo with the real SDK client over stdio, bilingual README)

Also: PR to awesome-mcp-servers is open ([#13058](https://github.com/punkpeye/awesome-mcp-servers/pull/13058)) while it clears the new Glama listing requirement.

## 提示

- 发帖时间：美东上午（北京时间 21:00–24:00 左右）社区活跃度高。
- flair 用 "P"（Project）或 "Resource"。
- 贴完把链接补到 PR 描述里（可选，增加可信度）。
