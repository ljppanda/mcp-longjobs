import { describe, expect, it, vi } from "vitest";
import { DurableError, MemorySessionStore } from "../src/core/index.js";
import { withTasks, type TaskContext } from "../src/tasks/with-tasks.js";
import { FakeRegistrar, structured } from "./helpers.js";

describe("withTasks fallback facade", () => {
  it("returns a handle immediately, exposes progress, then completes", async () => {
    const fake = new FakeRegistrar();
    const tasks = withTasks(fake, { store: new MemorySessionStore() });

    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => (release = resolve));
    let progressCalls = 0;

    tasks.taskTool("slow_job", { description: "test" }, async (_args, ctx: TaskContext) => {
      await ctx.progress("half", 0.5);
      progressCalls += 1;
      await gate;
      return { ok: true };
    });

    const start = structured(await fake.invoke("slow_job", {}));
    expect(start.status).toBe("working");
    expect(typeof start.taskId).toBe("string");
    expect(start.pollWith).toBe("durable_task_get");

    await vi.waitFor(() => expect(progressCalls).toBe(1));
    const working = structured(await fake.invoke("durable_task_get", { taskId: start.taskId }));
    expect(working.status).toBe("working");
    expect(working.progress).toEqual({ message: "half", fraction: 0.5 });

    release(null);
    await vi.waitFor(async () => {
      const done = structured(await fake.invoke("durable_task_get", { taskId: start.taskId }));
      expect(done.status).toBe("completed");
    });
    const done = structured(await fake.invoke("durable_task_get", { taskId: start.taskId }));
    expect(done.result).toEqual({ ok: true });
  });

  it("pauses for input (input_required) and resumes on respond", async () => {
    const fake = new FakeRegistrar();
    const tasks = withTasks(fake, { store: new MemorySessionStore() });

    tasks.taskTool("confirm_job", {}, async (_args, ctx: TaskContext) => {
      const answer = await ctx.needInput({ prompt: "Overwrite the file?", choices: ["yes", "no"] });
      return { answer };
    });

    const start = structured(await fake.invoke("confirm_job", {}));
    await vi.waitFor(async () => {
      const paused = structured(await fake.invoke("durable_task_get", { taskId: start.taskId }));
      expect(paused.status).toBe("input_required");
      expect(paused.inputRequest).toEqual({ prompt: "Overwrite the file?", choices: ["yes", "no"] });
    });

    const responded = structured(
      await fake.invoke("durable_task_respond", { taskId: start.taskId, response: "yes" }),
    );
    expect(responded.status).toBe("working");

    await vi.waitFor(async () => {
      const done = structured(await fake.invoke("durable_task_get", { taskId: start.taskId }));
      expect(done.status).toBe("completed");
    });
    const done = structured(await fake.invoke("durable_task_get", { taskId: start.taskId }));
    expect(done.result.answer).toBe("yes");
  });

  it("failures are structured, model-repairable envelopes", async () => {
    const fake = new FakeRegistrar();
    const tasks = withTasks(fake, { store: new MemorySessionStore() });

    tasks.taskTool("boom", {}, async () => {
      throw new DurableError({
        code: "invalid_param",
        message: "date out of range",
        param: "date",
        retryable: true,
        recoveryHint: "Use ISO 8601, e.g. 2026-08-28.",
      });
    });

    const start = structured(await fake.invoke("boom", {}));
    await vi.waitFor(async () => {
      const failed = structured(await fake.invoke("durable_task_get", { taskId: start.taskId }));
      expect(failed.status).toBe("failed");
      expect(failed.error.code).toBe("invalid_param");
      expect(failed.error.param).toBe("date");
      expect(failed.error.recoveryHint).toBe("Use ISO 8601, e.g. 2026-08-28.");
    });
  });

  it("cancellation is cooperative and keeps the terminal status", async () => {
    const fake = new FakeRegistrar();
    const tasks = withTasks(fake, { store: new MemorySessionStore() });
    let sawAbort = false;

    tasks.taskTool("cancellable", {}, async (_args, ctx: TaskContext) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          sawAbort = true;
          resolve();
        });
        setTimeout(resolve, 5_000); // safety net so the test can never hang
      });
      if (ctx.signal.aborted) throw new Error("cancelled");
      return { done: true };
    });

    const start = structured(await fake.invoke("cancellable", {}));
    const cancelled = structured(await fake.invoke("durable_task_cancel", { taskId: start.taskId }));
    expect(cancelled.status).toBe("cancelled");

    await vi.waitFor(() => expect(sawAbort).toBe(true));
    const rec = structured(await fake.invoke("durable_task_get", { taskId: start.taskId }));
    expect(rec.status).toBe("cancelled");
  });

  it("unknown task ids return a repairable envelope", async () => {
    const fake = new FakeRegistrar();
    const tasks = withTasks(fake, { store: new MemorySessionStore() });
    // The facade installs lazily on the first taskTool registration.
    tasks.taskTool("placeholder", {}, async () => ({ ok: true }));
    const res = structured(await fake.invoke("durable_task_get", { taskId: "task_nope" }));
    expect(res.error.code).toBe("unknown_task");
    expect(res.error.retryable).toBe(false);
  });
});
