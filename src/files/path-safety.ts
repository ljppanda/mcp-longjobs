import { resolve, sep } from "node:path";

function normalized(p: string): string {
  const r = resolve(p);
  // Windows paths are case-insensitive.
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** True when `target` is `root` itself or lives underneath it. */
export function isInsideRoot(root: string, target: string): boolean {
  const r = normalized(root);
  const t = normalized(target);
  return t === r || t.startsWith(r + sep);
}
