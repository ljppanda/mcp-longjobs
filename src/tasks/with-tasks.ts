import {
  DurableError,
  MemorySessionStore,
  isTerminal,
  newId,
  serializeError,
  textResult,
  type SessionRecord,
  type SessionStore,
  type ToolExtra,
  type ToolRegistrar,
} from "../core/index.js";
import { installFacade } from "./facade.js";
import type { TaskRuntime } from "./types.js";

/**
 * Handle handed to a task handler. `signal` is aborted by durable_task_cancel;
 * cooperative tasks check it between steps and bail out early.
 */
export interface TaskContext {
  readonly taskId: string;
  readonly signal: AbortSignal;
  /**
   * Report progress. Surfaced to clients via notifications/progress when the
   * client provided a progressToken, and via polling always.
   */
  progress(message?: string, fraction?: number): Promise<void>;
  /**
   * Pause the task and ask a question. The model answers through the facade
   * (durable_task_respond), then the task continues where it left off.
   */
  needInput(question: { prompt: string; choices?: string[] }): Promise<string>;
}

export interface WithTasksOptions {
  /** Defaults to MemorySessionStore; use JsonFileSessionStore for restart-safe tasks. */
  store?: SessionStore;
  /** Facade tool name prefix. Default "durable_task". */
  facadePrefix?: string;
  /** Suggested polling interval returned to the model. Default 1000ms. */
  pollIntervalMs?: number;
  /** How long finished task records are kept. Default 24h. */
  ttlMs?: number;
}

export interface TasksServer {
  /**
   * Register a tool whose work runs in the background. The tool call returns
   * immediately with a durable handle; the model polls with the facade tools.
   * Works on every MCP client — no Tasks-extension support required.
   */
  taskTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: Record<string, unknown> },
    handler: (args: unknown, ctx: TaskContext) => Promise<unknown>,
  ): void;
  /** The underlying registrar, for registering ordinary (fast) tools too. */
  registrar: ToolRegistrar;
}

interface Runtime extends TaskRuntime {
  // TaskRuntime + nothing extra today; a named type keeps call sites tidy.
}

/**
 * Wrap a tool registrar with durable-task support.
 *
 * Pass your McpServer via asToolRegistrar(). The native ext-tasks protocol
 * (CreateTaskResult / tasks/get / tasks/update) is planned as an adapter;
 * until clients ship support for it, the facade below is what actually runs,
 * and it implements the same lifecycle vocabulary.
 */
export function withTasks(registrar: ToolRegistrar, options: WithTasksOptions = {}): TasksServer {
  const rt: Runtime = {
    store: options.store ?? new MemorySessionStore(),
    facadePrefix: options.facadePrefix ?? "durable_task",
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
    ttlMs: options.ttlMs ?? 24 * 60 * 60 * 1_000,
    pendingInput: new Map(),
    controllers: new Map(),
    facadeInstalled: false,
  };

  return {
    registrar,
    taskTool(name, config, handler) {
      installFacade(rt, registrar);
      registrar.registerTool(name, config, async (args: unknown, extra: ToolExtra) => {
        const taskId = newId("task");
        const controller = new AbortController();
        rt.controllers.set(taskId, controller);
        const now = new Date().toISOString();
        await rt.store.create({
          id: taskId,
          kind: "task",
          tool: name,
          status: "working",
          createdAt: now,
          updatedAt: now,
          ttlMs: rt.ttlMs,
        });
        // The work continues in the background; the tool call returns now,
        // which is exactly what prevents client-side timeouts.
        void runTask(rt, handler, args, taskId, extra, controller.signal).catch(() => {});
        return textResult({
          taskId,
          status: "working",
          pollIntervalMs: rt.pollIntervalMs,
          pollWith: `${rt.facadePrefix}_get`,
          note: `Long-running operation started in the background. Call ${rt.facadePrefix}_get with this taskId and repeat until status is "completed" or "failed". If interrupted, the task id stays valid after a reconnect.`,
        });
      });
    },
  };
}

async function runTask(
  rt: Runtime,
  handler: (args: unknown, ctx: TaskContext) => Promise<unknown>,
  args: unknown,
  taskId: string,
  extra: ToolExtra,
  signal: AbortSignal,
): Promise<void> {
  try {
    const result = await handler(args, {
      taskId,
      signal,
      progress: async (message, fraction) => {
        await rt.store.update(taskId, { progress: { message, fraction } });
        await sendProgress(extra, fraction, message);
      },
      needInput: async (question) => {
        await rt.store.update(taskId, { status: "input_required", meta: { question } });
        try {
          const answer = await Promise.race([
            new Promise<string>((resolve) => rt.pendingInput.set(taskId, resolve)),
            new Promise<never>((_, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new DurableError({ code: "cancelled", message: "Task cancelled while waiting for input." })),
                { once: true },
              );
            }),
          ]);
          // Resume the lifecycle, otherwise the task is stuck in
          // input_required and the completion guard below would skip it.
          await rt.store.update(taskId, { status: "working", meta: {} });
          return answer;
        } finally {
          rt.pendingInput.delete(taskId);
        }
      },
    });
    const current = await rt.store.get(taskId);
    // Only mark completed if nothing cancelled the task in the meantime.
    if (current && current.status === "working") {
      await rt.store.update(taskId, {
        status: "completed",
        result,
        progress: { message: "done", fraction: 1 },
      });
    }
  } catch (err) {
    // Cancellation already recorded its terminal status; don't overwrite it.
    if (!signal.aborted) {
      await rt.store.update(taskId, { status: "failed", error: serializeError(err) });
    }
  } finally {
    rt.controllers.delete(taskId);
  }
}

async function sendProgress(extra: ToolExtra, fraction?: number, message?: string): Promise<void> {
  const token = extra?._meta?.["progressToken"];
  // Best effort: clients that didn't ask for progress just poll. The store
  // record is the source of truth either way.
  if (!extra?.sendNotification || token === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: typeof fraction === "number" ? Math.round(fraction * 100) : 0,
        total: 100,
        ...(message ? { message } : {}),
      },
    });
  } catch {
    // Progress notifications are optional on the client side.
  }
}

// Re-exported for convenience so consumers can type their handlers.
export type { SessionRecord };
