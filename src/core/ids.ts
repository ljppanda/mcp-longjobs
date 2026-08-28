import { randomUUID } from "node:crypto";

/** Prefixed, URL-safe, collision-resistant id: `task_9f2c1e7a...` */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
