import type { SessionStore } from "../core/index.js";

/** Shared runtime state for the tasks facade. */
export interface TaskRuntime {
  store: SessionStore;
  facadePrefix: string;
  pollIntervalMs: number;
  ttlMs: number;
  /** Resolvers for tasks currently paused in needInput(). */
  pendingInput: Map<string, (value: string) => void>;
  /** AbortControllers for tasks running in this server process. */
  controllers: Map<string, AbortController>;
  facadeInstalled: boolean;
}
