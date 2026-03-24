import { AsyncLocalStorage } from "node:async_hooks";
import { notify } from "./notify.js";
import { insertJobLog } from "./db.js";
import { LOG_LEVEL } from "./config.js";

interface RunContext {
  runId: string;
}

export const runContext = new AsyncLocalStorage<RunContext>();

const SEVERITY: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level: string): boolean {
  return SEVERITY[level]! >= SEVERITY[LOG_LEVEL]!;
}

function ts(): string {
  return new Date().toISOString();
}

function captureLog(level: string, msg: string): void {
  const store = runContext.getStore();
  if (store) {
    try {
      insertJobLog(store.runId, level, msg);
    } catch {
      // Don't let DB errors interrupt the job
    }
  }
}

export function debug(msg: string): void {
  if (!shouldLog("debug")) return;
  console.log(`${ts()} [DEBUG] ${msg}`);
  captureLog("debug", msg);
}

export function info(msg: string): void {
  if (!shouldLog("info")) return;
  console.log(`${ts()} [INFO] ${msg}`);
  captureLog("info", msg);
}

export function warn(msg: string): void {
  if (!shouldLog("warn")) return;
  console.warn(`${ts()} [WARN] ${msg}`);
  captureLog("warn", msg);
}

export function error(msg: string): void {
  // error() is never gated — it triggers notifications and must always execute
  console.error(`${ts()} [ERROR] ${msg}`);
  notify(`[ERROR] ${msg}`);
  captureLog("error", msg);
}

export function withRunContext<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return runContext.run({ runId }, fn);
}
