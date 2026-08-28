# Show HN 发布草稿

## 标题选项

- Show HN: mcp-longjobs — long-running MCP tools and large files that survive client restarts (works on every client today)
- Show HN: The MCP spec added Tasks in July. No client supports it yet. So I shipped the fallback.

## 正文

The 2026-07-28 MCP spec introduced Tasks — async tool calls with durable handles, mid-flight input, and resumability. But the client support matrix still has zero clients implementing it, and the spec says servers MUST NOT return a task to a client that didn't opt in. So every long-running MCP server needs a fallback path anyway.

mcp-longjobs is that fallback, as a drop-in library for MCP server authors:

- `withTasks()` — long-running tool calls return a durable taskId instantly (no more 10–60s client timeouts). The model polls a generated `durable_task_get` facade tool, sees progress, answers mid-flight questions (`input_required` → `durable_task_respond`), and cancels cooperatively. State lives in a pluggable store (memory or JSON file), so the taskId survives client crashes and reconnects.
- `withFileTransfer()` — chunked upload/download with a resume cursor, offset enforcement, and sha256 verification at commit. Failures are structured envelopes (`code` / `retryable` / `recoveryHint` / `partial.cursor`) the model can repair in one round-trip instead of blind retries.
- Lifecycle vocabulary matches the spec (`working / input_required / completed / failed / cancelled`), so the native adapter can slot in later without breaking changes.

Design rule: bytes never flow through the model — it sees handles, sizes, and checksums; the model is the director, not the courier.

17 unit tests + an end-to-end demo that drives the real SDK client over stdio (`npm run demo`). MIT.

Repo: https://github.com/ljppanda/mcp-longjobs

Happy to answer questions about the protocol-level reasoning — the gap analysis (spec shipped, adoption zero) is in the README.

## 评论区可准备的回应

- 为什么不用官方 SDK 的实验性 Tasks？→ 官方 SDK 的实验性 Tasks 需要客户端声明支持，而目前客户端矩阵是空的；降级路径是规范强制的必选项。原生适配器在路线图上。
- 和 fastmcp 的关系？→ fastmcp 是完整框架（也在做流式部分结果）；mcp-longjobs 是聚焦"持久化 + 恢复 + 错误信封"的中间件，可与官方 SDK 或任何 registerTool 兼容的宿主组合。
- 大文件为什么不直接 base64？→ 33% 膨胀 + 消息大小上限 + 上下文爆炸；走分片游标 + 校验和，大文件后续加 TUS 带外端点（对齐官方 File Uploads WG 的方向）。
