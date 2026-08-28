# 掘金/V2EX 发布草稿

## 标题选项

- 我给 MCP 写了个库：长时任务和大文件传输，在今天的每个客户端上都能用
- MCP 规范发布了 Tasks，但没有任何客户端支持——所以我做了降级方案

## 正文结构

### 开头（问题）

- MCP 工具调用有超时限制（常见 10–60 秒），爬虫、批处理、生成报告这类慢工具必挂；模型"重试"是重头再来。
- 大文件没有传输方案：base64 内联（33% 体积膨胀 + SDK 消息大小上限）或裸 URL（无分片、无断点续传、无校验）。
- 2026-07-28 规范新增 Tasks 扩展（异步执行、持久句柄、中途输入），但客户端支持矩阵至今是空的，规范还强制要求"不向未声明支持的客户端返回 task"——**每个长时 server 都需要一条降级路径**。

### 方案（代码示例）

```ts
const tasks = withTasks(registrar, { store });

tasks.taskTool("crawl-site", { ... }, async (args, ctx) => {
  for (const page of pages) {
    if (ctx.signal.aborted) throw new Error("cancelled");
    await ctx.progress(`已抓取 ${page.url}`, done / total);
    const answer = await ctx.needInput({ prompt: `包含 ${page.url} 吗？` });
  }
  return { summary, reportPath };
});
```

- 调用立即返回 taskId，模型轮询 `durable_task_get` 看进度；`input_required` 时通过 `durable_task_respond` 应答继续；`durable_task_cancel` 协作取消。
- 状态存 JSON 文件，**客户端重启后 taskId 依然有效**。
- 分片传输：`file_transfer_open/write/read/commit`，偏移量错误返回带 `partial.cursor` 的修复信封，commit 校验 sha256。

### 设计要点

- 字节永远不过模型（模型是指挥不是搬运工）
- 失败是可修复的数据：`code / retryable / recoveryHint / partial`
- 生命周期词汇与规范对齐，原生适配器后续无痛接入

### 验证

- 17 个单元测试 + 用真实 SDK 客户端跑端到端（`npm run demo`：任务 4 次轮询完成、上传分片 + 校验、下载对账）
- 双向 README（中文文档完整）
- 仓库：https://github.com/ljppanda/mcp-longjobs （MIT）

### 结尾

- 下一步：原生 ext-tasks 适配器、TUS 带外大文件端点（对齐官方 File Uploads WG 方向）、SQLite/Redis 存储
- 欢迎 PR / issue；想了解协议层空白的分析可以看 README

## 发布提示

- 掘金：标签选"后端/AI"，配一张流程 GIF 效果最好（截图任务轮询输出即可）。
- V2EX：发"分享创造"节点，正文别太长，链接放开头。
- 中文社区对"规范刚发布、生态没跟上"这个时点叙述接受度高，这是差异化卖点。
