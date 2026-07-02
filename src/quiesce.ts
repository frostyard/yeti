import fs from "node:fs";
import path from "node:path";
import { WORK_DIR } from "./config.js";

/**
 * Graceful-update coordination. `deploy.sh` writes this sentinel (containing the
 * target release tag) when an update is staged. While it exists, the scheduler
 * refuses to START new job runs, letting in-flight work drain to zero before the
 * deploy stops the service — so an update never kills a long AI run mid-flight.
 * The daemon clears it on startup so a crashed/aborted deploy can't wedge us.
 */
export const QUIESCE_PATH = path.join(WORK_DIR, "quiesce");

export function isUpdatePending(): boolean {
  try {
    return fs.existsSync(QUIESCE_PATH);
  } catch {
    return false;
  }
}

/** The staged release tag written into the sentinel, or null. */
export function pendingUpdateTag(): string | null {
  try {
    const tag = fs.readFileSync(QUIESCE_PATH, "utf8").trim();
    return tag || null;
  } catch {
    return null;
  }
}

/** Remove the sentinel (called on startup, and by deploy.sh on completion/abort). */
export function clearQuiesce(): void {
  try {
    fs.rmSync(QUIESCE_PATH, { force: true });
  } catch {
    /* ignore */
  }
}
