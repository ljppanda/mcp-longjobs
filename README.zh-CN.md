# mcp-longjobs

**给 MCP 提供持久化、可恢复的操作——长时任务和大文件传输，扛得住超时、断连和客户端重启。今天就能在所有客户端上用。**

[![CI](https://github.com/ljppanda/mcp-longjobs/actions/workflows/ci.yml/badge.svg)](https://github.com/ljppanda/mcp-longjobs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-longjobs)](https://www.npmjs.com/package/mcp-longjobs)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[English](./README.md)

## 问题在哪里

三件事让所有"干真活"的 MCP server 头疼：

- **长时工具调用必然超时。** 客户端对单次调用有超时限制（通常 10–60 秒）。爬虫、构建、批处理任务一超时报错，模型"重试"又是从头再跑一遍。
- **失败不可修复。** 工具调用失败只返回一段自由格式的报错，模型只能瞎猜：盲试还是放弃。它没法只改一个参数、从断点续跑。
- **大文件没有传输方案。** 二进制内容要么 base64 内联塞 JSON（体积膨胀 33%，还有消息大小上限），要么给个裸 URL——没有分片、没有断点续传、没有完整性校验。

[2026-07-28 版 MCP 规范](https://modelcontextprotocol.io/specification/2026-07-28)新增了 [Tasks 扩展](https://modelcontextprotocol.io/extensions/tasks/overview)——异步执行、中途输入、持久句柄。但[目前没有任何客户端支持它](https://modelcontextprotocol.io/extensions/client-matrix)，而且规范要求服务器对未声明支持的客户端拒绝返回 task。**所以每个长时任务 server 都需要一条能在今天的客户端上跑的降级路径。这个包就是这条路径。**

## 提供什么

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JsonFileSessionStore, withTasks, withFileTransfer, asToolRegistrar } from "mcp-longjobs";

const mcp = new McpServer({ name: "my-server", version: "1.0.0" });
const registrar = asToolRegistrar(mcp);
const store = new JsonFileSessionStore("./state/sessions.json");

const tasks = withTasks(registrar, { store });

tasks.taskTool("crawl-site", {
  description: "爬一个站点并产出报告（需要几分钟）",
  inputSchema: { url: z.string(), maxPages: z.number().default(50) },
}, async (args, ctx) => {
  for (const page of pages) {
    if (ctx.signal.aborted) throw new Error("cancelled");
    await ctx.progress(`已抓取 ${page.url}`, done / total);

    if (needsConfirmation(page)) {
      const answer = await ctx.needInput({ prompt: `要包含 ${page.url} 吗？`, choices: ["yes", "no"] });
      if (answer === "no") continue;
    }
  }
  return { summary, reportPath }; // 给模型的小结果；大文件走 file transfer
});

withFileTransfer(registrar, { store, storageDir: "./state/blobs" });
```

在**今天的客户端**上（不需要 Tasks 支持），模型的体验是：

1. 调用 `crawl-site` **立即返回** `taskId`，并附带"轮询 `durable_task_get` 直到完成"的指引——不再超时。
2. 轮询能看到实时进度：`{ "status": "working", "progress": { "message": "已抓取 /pricing", "fraction": 0.4 } }`。
3. 任务中途需要确认时暂停为 `input_required`；模型通过 `durable_task_respond` 作答，任务从暂停处继续。
4. **客户端崩了？换会话了？** 用同一个 `taskId` 调 `durable_task_get` 照样有效——状态存在 store 里，不在连接里。
5. `durable_task_cancel` 在下一个检查点协作式取消任务。

失败是**数据，不是协议错误**——一个模型一轮对话就能修复的结构化信封：

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

## 包结构（子路径导出）

| 导入 | 用途 |
| --- | --- |
| `mcp-longjobs/tasks` | `withTasks()` + `durable_task_*` facade：后台执行、进度、中途输入、协作取消 |
| `mcp-longjobs/files` | `withFileTransfer()`：分片上传/下载、断点游标、sha256 校验、路径安全根目录 |
| `mcp-longjobs/core` | 会话模型、可插拔 Store（内存 / JSON 文件）、结构化错误信封 |

## 设计要点

- **字节永远不过模型。** 模型只看元数据：句柄、大小、sha256、进度。走工具调用传分片只适合中小文件；大文件应走带外通道（TUS 端点规划中），模型只负责核对校验和。
- **模型是指挥，不是搬运工。** facade 工具的返回结果自带指引（"用这个 id 调 `durable_task_get`"、"从 offset N 续传"），任何够聪明的模型都能零成本驱动这套协议，不需要宿主端配合。
- **失败是可修复的数据。** 每个失败都带 `code`、`retryable`、`recoveryHint`、`partial.cursor`——哪里错了、重试有没有意义、该怎么做、哪些已经完成。
- **生命周期词汇与规范对齐。** `working / input_required / completed / failed / cancelled`，将来原生适配器接入时不需要破坏性变更。

## 状态

| 组件 | 状态 |
| --- | --- |
| Tasks 降级 facade（进度 / 输入 / 取消） | ✅ 已实现 |
| 持久会话存储（内存、JSON 文件） | ✅ 已实现 |
| 分片文件传输（断点续传 + 校验和） | ✅ 已实现 |
| 原生 ext-tasks 适配器（`CreateTaskResult` / `tasks/get`） | 🔜 跟进 SDK 的实验性 Tasks API |
| TUS 1.0 带外大文件端点 | 🔜 规划中——见 [mcp#189](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/189) |
| Redis / SQLite 存储、Python 版 | 🔜 规划中 |

## 快速开始

```bash
git clone https://github.com/ljppanda/mcp-longjobs
cd mcp-longjobs
npm install && npm run build
node dist/examples/report-generator.js
```

（发布到 npm 后，一条命令即可运行同一个 server：`npx mcp-longjobs`。）

把客户端指过去（stdio）：

```json
{
  "mcpServers": {
    "report-generator": {
      "command": "node",
      "args": ["/绝对路径/mcp-longjobs/dist/examples/report-generator.js"]
    }
  }
}
```

然后问："生成一份关于动力电池的报告，3 个章节。"观察模型启动任务、轮询 `durable_task_get`、拿到结果。中途杀掉客户端再重启，用同一个 taskId 继续问——任务照样恢复。

## 开发

```bash
npm install
npm test         # vitest
npm run build    # tsc -> dist/
npm run example  # 构建 + 运行示例 server
```

## 参与贡献

欢迎 PR——尤其是：存储后端（SQLite/Redis）、原生 ext-tasks 适配器、TUS 端点。较大的改动请先开 issue。

## 许可证

[MIT](./LICENSE)
