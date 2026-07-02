import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORK_DIR } from "./config.js";
import * as log from "./log.js";

/**
 * Autonomy tier for a repo. Mirrors Hive's AgentMode -> policy-suffix mapping
 * (pkg/agent/mode.go). Controls WHICH policy variant a job loads, layered on
 * top of the enforcement Yeti already does in code (tree-diff guard, auto-merger).
 */
export type Autonomy = "advisory" | "issues" | "pr" | "automerge";

const SUFFIX: Record<Autonomy, string> = {
  advisory: "-advisory",
  issues: "-issues",
  pr: "-full",
  automerge: "-automerge",
};

// Bundled defaults ship next to the compiled code (dist/policies in prod,
// src/policies in dev), so a fresh install always has a working set even with
// no user overrides. User overrides live under ~/.yeti/policies and win.
// Matches Hive's embedded-defaults + on-disk override pattern.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.join(HERE, "policies");
const OVERRIDE_DIR = path.join(WORK_DIR, "policies");

/** Search dirs in priority order (first hit wins): user override, then bundled. */
export function defaultPolicyDirs(): string[] {
  return [OVERRIDE_DIR, BUNDLED_DIR];
}

/** Number of distinct <name>.md policy files across dirs (earlier dirs shadow later). */
export function countPolicyFiles(dirs: string[]): number {
  const names = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // dir absent — skip
    }
    for (const e of entries) {
      if (e.endsWith(".md")) names.add(e);
    }
  }
  return names.size;
}

/** In-memory cache: resolved absolute path -> file contents. Cleared on reload. */
const cache = new Map<string, string>();

/**
 * Replace ${VAR} placeholders with vars[VAR] in a single pass. Unknown keys are
 * left intact so a typo is visible, not silently blank. Substituted values are
 * NOT re-scanned, so a value containing ${...} or $ is treated literally.
 * (Deliberately dumb, like Hive's strings.NewReplacer.)
 */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? vars[key] : whole,
  );
}

/**
 * Distinct ${VAR} names present in `template` but absent from `vars`, in
 * first-seen order. Compares against the TEMPLATE's placeholders, not the
 * rendered output, so a value that itself contains ${...} is never flagged.
 */
export function findMissingVars(template: string, vars: Record<string, string>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(/\$\{(\w+)\}/g)) {
    const key = m[1];
    if (!(key in vars) && !seen.has(key)) {
      seen.add(key);
      missing.push(key);
    }
  }
  return missing;
}

/**
 * Resolve a policy file by job name + autonomy across `dirs` in order,
 * first hit wins. Within each dir the autonomy-suffixed variant beats the base.
 * Returns the absolute path, or null if nothing matches.
 */
export function resolvePolicyPath(
  job: string,
  autonomy: Autonomy,
  dirs: string[],
): string | null {
  const suffix = SUFFIX[autonomy];
  for (const dir of dirs) {
    const suffixed = path.join(dir, `${job}${suffix}.md`);
    if (fs.existsSync(suffixed)) return suffixed;
    const base = path.join(dir, `${job}.md`);
    if (fs.existsSync(base)) return base;
  }
  return null;
}

function read(absPath: string): string {
  const cached = cache.get(absPath);
  if (cached !== undefined) return cached;
  const data = fs.readFileSync(absPath, "utf8");
  cache.set(absPath, data);
  return data;
}

export interface RenderOptions {
  /** Fallback prompt when no policy file exists (keeps a job working pre-migration). */
  fallback?: () => string;
  /** Override search dirs (tests). Defaults to defaultPolicyDirs(). */
  dirs?: string[];
}

/**
 * Load policy `<job>` for `autonomy`, substitute ${VAR} placeholders, and return
 * the rendered prompt. If no file is found, uses opts.fallback if given, else throws.
 */
export function renderPolicy(
  job: string,
  autonomy: Autonomy,
  vars: Record<string, string>,
  opts: RenderOptions = {},
): string {
  const dirs = opts.dirs ?? defaultPolicyDirs();
  const absPath = resolvePolicyPath(job, autonomy, dirs);
  if (!absPath) {
    if (opts.fallback) return opts.fallback();
    throw new Error(`No policy found for job "${job}" (autonomy=${autonomy})`);
  }
  const template = read(absPath);
  const missing = findMissingVars(template, vars);
  if (missing.length) {
    log.warn(`policy ${absPath}: unsubstituted ${missing.map((v) => "${" + v + "}").join(", ")}`);
  }
  return substitute(template, vars);
}

/**
 * Watch the policy dirs and clear the cache on change, debounced 500ms so an
 * editor's atomic-rename save (multiple fs events) reloads once. Mirrors
 * config/watcher.go's debounce. Call once from startup. Never keeps the process
 * alive on its own (persistent: false).
 */
export function watchPolicies(): void {
  let timer: NodeJS.Timeout | undefined;
  const invalidate = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      cache.clear();
      log.info(`Policies reloaded (${countPolicyFiles(defaultPolicyDirs())} loaded)`);
    }, 500);
  };
  for (const dir of defaultPolicyDirs()) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.watch(dir, { recursive: true, persistent: false }, invalidate);
    } catch (err) {
      log.warn(`Failed to watch policy dir ${dir}: ${(err as Error).message}`);
    }
  }
}
