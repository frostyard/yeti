import fs from "node:fs";
import path from "node:path";
import * as log from "./log.js";
import { notify } from "./notify.js";
import { discordStatus } from "./discord.js";

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
    notify({ jobName: "system", message: `Yeti started with updated version ${version}` });
    const status = discordStatus();
    if (status.connected) {
      log.info(`Announced deployment: ${version}`);
    } else {
      log.warn(`Skipped deployment announcement (Discord not connected): ${version}`);
    }
    fs.writeFileSync(versionFile, version);
  }
}
