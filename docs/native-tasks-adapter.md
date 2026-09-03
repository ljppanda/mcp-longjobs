# Native ext-tasks adapter — design note (status: blocked)

Surveyed against `@modelcontextprotocol/sdk@1.30.0` (2026-09-03).

## Goal

When a client declares support for the Tasks extension
(`io.modelcontextprotocol/tasks` in per-request `_meta`), `withTasks()` should
return a real `CreateTaskResult` (per the [ext-tasks spec](https://modelcontextprotocol.io/extensions/tasks/overview))
instead of the fallback facade, so the model polls `tasks/get` natively and
facade tools (`durable_task_*`) can be hidden from the tool list.

## What the SDK exposes today (1.30.0)

- Protocol types in `spec.types.d.ts`: `CreateTaskResult`, `TaskResult`,
  `TaskStatus`, `tasks/get`, `tasks/cancel`, `tasks/update` request schemas.
- Request schema constants in `types.js`:
  `RELATED_TASK_META_KEY`, `ListToolsRequestSchema`, `CallToolRequestSchema`,
  `GetTaskRequestSchema`, `GetTaskPayloadRequestSchema`.
- Experimental server-side helpers in
  `experimental/tasks/`: `interfaces.js` (`isTerminal`), `stores/in-memory.js`
  (`InMemoryTaskStore`).
- Reference implementation: `examples/server/simpleTaskInteractive.js` —
  raw `Server` (not `McpServer`), a hand-rolled per-task message queue with
  resolvers, and tools that return task ids for later `tasks/result` fetches.

## Why it is blocked

1. **No `McpServer`-level support.** The example wires task routes onto the
   low-level `Server`. Our `asToolRegistrar()` seam sits at the high-level
   `registerTool` surface, which has no task-aware path yet — there is no
   documented way for a high-level tool handler to return a `CreateTaskResult`
   and have the SDK serve `tasks/get`.
2. **No client support.** The official client matrix still lists zero clients
   for Tasks, so any implementation is untestable end-to-end and unshippable
   as the default path.
3. **Experimental API churn.** `experimental/tasks/` moves between SDK minor
   releases; pinning to it now creates maintenance debt with no users.

## Integration seam (for when the blockers clear)

1. Capability detection: read the client's per-request `_meta` for
   `io.modelcontextprotocol/clientCapabilities.extensions["io.modelcontextprotocol/tasks"]`.
   `ToolExtra._meta` already flows through `withTasks` — the seam exists.
2. Handler behavior: if supported, the taskTool wrapper returns the SDK's
   `CreateTaskResult` (`{ resultType: "task", taskId, status, ttlMs,
   pollIntervalMs }`) with a durable task store (our `SqliteSessionStore`
   already fits the record shape; lifecycle vocabulary already mirrors the
   spec: `working/input_required/completed/failed/cancelled`).
3. Facade suppression: only install `durable_task_*` facade tools when the
   client does NOT support the extension — keep tool lists clean for
   Tasks-capable hosts.
4. Re-check each SDK release for `McpServer` task helpers; the seam above was
   designed so switching is a wrapper change, not a redesign.

## Trigger to revisit

- `@modelcontextprotocol/sdk` documents task support at the `McpServer` level,
  OR
- any mainstream client ships Tasks extension support, OR
- `experimental/tasks/` graduates out of experimental.
