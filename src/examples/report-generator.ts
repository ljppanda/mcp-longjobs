/**
 * Demo server: shows the durable-task and chunked-file facades working on
 * today's MCP clients (no Tasks-extension support required).
 *
 * Try it:
 *   npm run build
 *   node dist/examples/report-generator.js
 *
 * Point your client at it (stdio), e.g. for Claude Code / Cursor:
 *   { "command": "node", "args": ["<repo>/dist/examples/report-generator.js"] }
 *
 * Then ask: "Generate a report on EV batteries with 3 sections" — the model
 * gets a taskId immediately and polls durable_task_get until completion.
 * Kill the client mid-run and ask again: the taskId is still valid.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JsonFileSessionStore } from "../core/index.js";
import { asToolRegistrar, withTasks } from "../tasks/index.js";
import { withFileTransfer } from "../files/index.js";

const here = dirname(fileURLToPath(import.meta.url)); // dist/examples
const stateDir = join(here, "..", "..", "state"); // <repo>/state
mkdirSync(join(stateDir, "reports"), { recursive: true });

const mcp = new McpServer({ name: "report-generator", version: "0.1.0" });
const registrar = asToolRegistrar(mcp);
const store = new JsonFileSessionStore(join(stateDir, "sessions.json"));

const tasks = withTasks(registrar, { store });

tasks.taskTool("generate-report", {
  title: "Generate a market report",
  description:
    "Simulates a slow job (~2s per section). Demonstrates background execution, progress polling, restart-safe state, and cooperative cancellation.",
  inputSchema: {
    topic: z.string().describe("Report topic"),
    sections: z.number().int().min(1).max(10).default(3),
  },
}, async (rawArgs, ctx) => {
  const args = rawArgs as { topic: string; sections: number };
  for (let i = 1; i <= args.sections; i += 1) {
    if (ctx.signal.aborted) throw new Error("cancelled by user");
    await new Promise((r) => setTimeout(r, 2_000));
    await ctx.progress(`Writing section ${i}/${args.sections}`, i / args.sections);
  }
  const reportPath = join(stateDir, "reports", `${ctx.taskId}.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `# ${args.topic}\n\nGenerated ${args.sections} sections.\n`);
  return { summary: `Report on "${args.topic}" is ready.`, reportPath };
});

// Chunked, resumable file transfers on the same server: pull generated
// reports (or anything under stateDir) chunk by chunk.
withFileTransfer(registrar, {
  store,
  storageDir: join(stateDir, "blobs"),
  allowedRoots: [stateDir],
});

await mcp.connect(new StdioServerTransport());
