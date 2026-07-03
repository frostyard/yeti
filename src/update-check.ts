import fs from "node:fs";
import path from "node:path";
import { WORK_DIR } from "./config.js";

export const UPDATE_CHECK_PATH = path.join(WORK_DIR, "update-check-requested");

/** Touch the sentinel watched by yeti-updater-trigger.path. */
export function requestUpdateCheck(): void {
  fs.writeFileSync(UPDATE_CHECK_PATH, `${new Date().toISOString()}\n`);
}
