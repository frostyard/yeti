import { EventEmitter } from "node:events";
import { notify as discordNotify } from "./discord.js";
import { insertNotification, type NotificationRow } from "./db.js";

export type NotificationLevel = "info" | "warn" | "error";

export interface Notification {
  jobName: string;
  message: string;
  url?: string;
  level?: NotificationLevel;
}

export const notificationEmitter = new EventEmitter();

export function notify(n: Notification): void {
  const level = n.level ?? "info";

  // 1. Insert into DB (error-safe — stderr only, no log.error to avoid recursion)
  let row: NotificationRow | undefined;
  try {
    row = insertNotification(n.jobName, n.message, n.url, level);
  } catch (err) {
    process.stderr.write(`[notify] DB insert failed: ${err}\n`);
  }

  // 2. Broadcast to SSE clients
  if (row) {
    notificationEmitter.emit("notification", row);
  }

  // 3. Forward to Discord
  const text = n.url
    ? `[${n.jobName}] ${n.message}\n${n.url}`
    : `[${n.jobName}] ${n.message}`;
  discordNotify(text);
}
