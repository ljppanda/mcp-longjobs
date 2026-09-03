import { z } from "zod";
import { isExpired, isTerminal, textResult, type ToolRegistrar, type ToolResult } from "../core/index.js";
import type { TaskRuntime } from "./types.js";

export function unknownTask(taskId: string): ToolResult {
  return textResult({
    error: {
      code: "unknown_task",
      message: `No task with id ${taskId}.`,
      retryable: false,
      recoveryHint:
        "The task id may be mistyped or the task's TTL has expired. Ask the user whether to re-run the original tool.",
    },
  });
}

/**
 * Install the poll/respond/cancel facade once. These ordinary tools give
 * clients without Tasks-extension support the full task experience: poll
 * status and progress, answer mid-flight questions, cancel cooperatively.
 */
export function installFacade(rt: TaskRuntime, registrar: ToolRegistrar): void {
  if (rt.facadeInstalled) return;
  rt.facadeInstalled = true;
  const prefix = rt.facadePrefix;

  registrar.registerTool(`${prefix}_get`, {
    title: "Get durable task status",
    description: `Poll a long-running task created by this server. Repeat until status is "completed" or "failed".`,
    inputSchema: { taskId: z.string() },
  }, async (args: unknown) => {
    const { taskId } = args as { taskId: string };
    const rec = await rt.store.get(taskId);
    if (!rec) return unknownTask(taskId);

    // Lazy TTL enforcement: a task nobody polled to completion expires.
    if (isExpired(rec)) {
      const error = {
        code: "expired",
        message: "The task's TTL expired before it completed (likely nothing polled it in time).",
        retryable: true,
        recoveryHint: "Re-run the original tool to start a fresh task.",
      };
      await rt.store.update(taskId, { status: "failed", error });
      return textResult({ taskId, status: "failed", tool: rec.tool ?? null, error });
    }

    if (rec.status === "input_required") {
      return textResult({
        taskId,
        status: rec.status,
        tool: rec.tool ?? null,
        inputRequest: rec.meta?.["question"] ?? null,
        respondWith: `${prefix}_respond`,
        note: "The task is paused and needs this input answered before it can continue.",
      });
    }
    if (rec.status === "completed") {
      return textResult({
        taskId,
        status: "completed",
        tool: rec.tool ?? null,
        result: rec.result ?? null,
      });
    }
    if (rec.status === "failed") {
      // Failures are data, not protocol errors: the structured envelope tells
      // the model how to repair the call in one round-trip.
      return textResult({
        taskId,
        status: "failed",
        tool: rec.tool ?? null,
        error: rec.error ?? null,
      });
    }
    if (rec.status === "cancelled") {
      return textResult({ taskId, status: "cancelled", tool: rec.tool ?? null });
    }
    return textResult({
      taskId,
      status: "working",
      tool: rec.tool ?? null,
      progress: rec.progress ?? null,
      startedAt: rec.createdAt,
      expiresAt: new Date(Date.parse(rec.createdAt) + rec.ttlMs).toISOString(),
      pollIntervalMs: rt.pollIntervalMs,
      note: "Still running. Call this tool again after pollIntervalMs.",
    });
  });

  registrar.registerTool(`${prefix}_respond`, {
    title: "Answer a durable task's question",
    description: "Deliver input that a paused task (status input_required) asked for.",
    inputSchema: { taskId: z.string(), response: z.string() },
  }, async (args: unknown) => {
    const { taskId, response } = args as { taskId: string; response: string };
    const rec = await rt.store.get(taskId);
    if (!rec) return unknownTask(taskId);

    const resolve = rt.pendingInput.get(taskId);
    if (resolve) {
      resolve(response);
      return textResult({
        taskId,
        status: "working",
        note: "Input delivered; the task continues in the background.",
      });
    }
    if (rec.status === "input_required") {
      const error = {
        code: "task_lost",
        message:
          "The server process restarted while the task was paused, so the paused step cannot continue.",
        retryable: true,
        recoveryHint: "Re-run the original tool. Work completed before the pause is unaffected.",
      };
      await rt.store.update(taskId, { status: "failed", error });
      return textResult({ taskId, status: "failed", error });
    }
    return textResult({
      taskId,
      status: rec.status,
      note: "No input is currently requested for this task.",
    });
  });

  registrar.registerTool(`${prefix}_cancel`, {
    title: "Cancel a durable task",
    description: "Cooperatively cancel a running task. The task stops at its next checkpoint.",
    inputSchema: { taskId: z.string() },
  }, async (args: unknown) => {
    const { taskId } = args as { taskId: string };
    const rec = await rt.store.get(taskId);
    if (!rec) return unknownTask(taskId);
    if (isTerminal(rec.status)) {
      return textResult({ taskId, status: rec.status, note: "Already finished; nothing to cancel." });
    }
    await rt.store.update(taskId, { status: "cancelled" });
    rt.controllers.get(taskId)?.abort();
    return textResult({
      taskId,
      status: "cancelled",
      note: "Cancellation requested; the task stops at its next checkpoint.",
    });
  });
}
