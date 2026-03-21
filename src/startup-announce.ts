import fs from "node:fs";
import path from "node:path";
import * as log from "./log.js";
import { notify } from "./notify.js";

export function announceIfNewVersion(version: string, workDir: string): void {
  if (version === "dev") return;

  const versionFile = path.join(workDir, "last-version");
  let lastVersion: string | null = null;
  try {
    lastVersion = fs.readFileSync(versionFile, "utf-8").trim();
  } catch {
    // First run — file doesn't exist yet
  }

  if (lastVersion !== version) {
    notify(`Yeti started with updated version ${version}`);
    log.info(`Announced deployment: ${version}`);
    fs.writeFileSync(versionFile, version);
  }
}
