import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { INTERVALS, SCHEDULES, LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB, WORK_DIR, ENABLED_JOBS, onConfigChange } from "./config.js";
import * as config from "./config.js";
import * as log from "./log.js";
import * as gh from "./github.js";
import { startJobs, type Job } from "./scheduler.js";
import { createServer } from "./server.js";
import { initDb, setRunIdProvider, getOrphanedTasks, recordTaskFailed, pruneOldLogs, closeDb } from "./db.js";
import { runContext } from "./log.js";
import * as issueWorker from "./jobs/issue-worker.js";
import * as issueRefiner from "./jobs/issue-refiner.js";
import * as ciFixer from "./jobs/ci-fixer.js";
import * as reviewAddresser from "./jobs/review-addresser.js";
import * as docMaintainer from "./jobs/doc-maintainer.js";
import * as autoMerger from "./jobs/auto-merger.js";
import * as repoStandards from "./jobs/repo-standards.js";
import * as improvementIdentifier from "./jobs/improvement-identifier.js";
import * as triageYetiErrors from "./jobs/triage-yeti-errors.js";
import * as issueAuditor from "./jobs/issue-auditor.js";
import * as discord from "./discord.js";
import { isDiscordConfigured } from "./discord.js";
import { setShuttingDown } from "./shutdown.js";
import { cancelQueuedTasks, cancelCurrentTask } from "./claude.js";
import { reportError } from "./error-reporter.js";
import { VERSION } from "./version.js";
import { announceIfNewVersion } from "./startup-announce.js";

log.info(`yeti ${VERSION} starting up`);

// ── Database init & recovery ──

initDb();
setRunIdProvider(() => runContext.getStore()?.runId);

const orphaned = getOrphanedTasks();
if (orphaned.length > 0) {
  log.info(`Found ${orphaned.length} orphaned task(s) from previous run — recovering`);

  const affectedRepoDirs = new Set<string>();

  for (const task of orphaned) {
    log.warn(
      `Recovering orphaned task: ${task.job_name} on ${task.repo}#${task.item_number}`,
    );

    if (task.worktree_path && fs.existsSync(task.worktree_path)) {
      try {
        fs.rmSync(task.worktree_path, { recursive: true, force: true });
        log.info(`Cleaned up orphaned worktree: ${task.worktree_path}`);
      } catch {
        // best effort
      }
    }

    // Track repo dir so we can prune stale worktree metadata below
    const repoDir = path.join(WORK_DIR, "repos", ...task.repo.split("/"));
    if (fs.existsSync(path.join(repoDir, ".git"))) {
      affectedRepoDirs.add(repoDir);
    }

    recordTaskFailed(task.id, "process restarted before completion");
  }

  // Prune stale git worktree metadata for repos whose worktrees were removed
  for (const dir of affectedRepoDirs) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "prune"], { cwd: dir }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    } catch {
      // best effort
    }
  }

  log.info(`Recovered ${orphaned.length} orphaned task(s)`);
}

// ── Log pruning ──

const pruned = pruneOldLogs(LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB);
if (pruned > 0) {
  log.info(`Pruned ${pruned} old job run(s) (retention: ${LOG_RETENTION_DAYS} days)`);
}

const pruneInterval = setInterval(() => {
  try {
    const n = pruneOldLogs(LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB);
    if (n > 0) log.info(`Pruned ${n} old job run(s)`);
  } catch {
    // best effort
  }
}, 24 * 60 * 60 * 1000);

// ── Jobs ──

const jobs: Job[] = [
  {
    name: "issue-worker",
    intervalMs: INTERVALS.issueWorkerMs,
    async run() {
      const repos = await gh.listRepos();
      log.info(`Discovered ${repos.length} repos`);
      await issueWorker.run(repos);
    },
  },
  {
    name: "issue-refiner",
    intervalMs: INTERVALS.issueRefinerMs,
    async run() {
      const repos = await gh.listRepos();
      await issueRefiner.run(repos);
    },
  },
  {
    name: "ci-fixer",
    intervalMs: INTERVALS.ciFixerMs,
    async run() {
      const repos = await gh.listRepos();
      await ciFixer.run(repos);
    },
  },
  {
    name: "review-addresser",
    intervalMs: INTERVALS.reviewAddresserMs,
    async run() {
      const repos = await gh.listRepos();
      await reviewAddresser.run(repos);
    },
  },
  {
    name: "doc-maintainer",
    intervalMs: 0,
    scheduledHour: SCHEDULES.docMaintainerHour,
    async run() {
      const repos = await gh.listRepos();
      await docMaintainer.run(repos);
    },
  },
  {
    name: "auto-merger",
    intervalMs: INTERVALS.autoMergerMs,
    async run() {
      const repos = await gh.listRepos();
      await autoMerger.run(repos);
    },
  },
  {
    name: "repo-standards",
    intervalMs: 0,
    scheduledHour: SCHEDULES.repoStandardsHour,
    runOnStart: true,
    async run() {
      const repos = await gh.listRepos();
      await repoStandards.run(repos);
    },
  },
  {
    name: "improvement-identifier",
    intervalMs: 0,
    scheduledHour: SCHEDULES.improvementIdentifierHour,
    async run() {
      const repos = await gh.listRepos();
      await improvementIdentifier.run(repos);
    },
  },
  {
    name: "issue-auditor",
    intervalMs: 0,
    scheduledHour: SCHEDULES.issueAuditorHour,
    async run() {
      const repos = await gh.listRepos();
      await issueAuditor.run(repos);
    },
  },
  {
    name: "triage-yeti-errors",
    intervalMs: INTERVALS.triageYetiErrorsMs,
    async run() {
      const repos = await gh.listRepos();
      await triageYetiErrors.run(repos);
    },
  },
];

// ── Job filtering ──

const knownJobNames = new Set(jobs.map(j => j.name));
for (const name of ENABLED_JOBS) {
  if (!knownJobNames.has(name)) {
    log.warn(`Unknown job in enabledJobs: "${name}" — ignoring`);
  }
}

const enabledSet = new Set(ENABLED_JOBS);
const enabledJobs = jobs.filter(j => enabledSet.has(j.name));
const skippedJobs = jobs.filter(j => !enabledSet.has(j.name));

if (skippedJobs.length > 0) {
  log.info(`Skipping disabled jobs: ${skippedJobs.map(j => j.name).join(", ")}`);
}
if (enabledJobs.length === 0) {
  log.warn("No jobs enabled — yeti is running but idle. Set enabledJobs in config.");
}

const scheduler = startJobs(enabledJobs, config.PAUSED_JOBS);
const server = createServer(scheduler);

// ── Live config reload ──

let prevIntervals = { ...INTERVALS };
let prevSchedules = { ...SCHEDULES };
let prevEnabledJobs = new Set(ENABLED_JOBS);

onConfigChange(() => {
  gh.clearRepoCache();

  const newIntervals = config.INTERVALS;
  const newSchedules = config.SCHEDULES;

  for (const [key, value] of Object.entries(newIntervals) as [keyof typeof newIntervals, number][]) {
    if (value !== prevIntervals[key]) {
      const jobName = key.replace(/Ms$/, "").replace(/([A-Z])/g, "-$1").toLowerCase();
      scheduler.updateInterval(jobName, value);
      log.info(`Config change: ${key} updated to ${value}ms`);
    }
  }

  for (const [key, value] of Object.entries(newSchedules) as [keyof typeof newSchedules, number][]) {
    if (value !== prevSchedules[key]) {
      const jobName = key.replace(/Hour$/, "").replace(/([A-Z])/g, "-$1").toLowerCase();
      scheduler.updateScheduledHour(jobName, value);
      log.info(`Config change: ${key} updated to ${value}:00`);
    }
  }

  prevIntervals = { ...newIntervals };
  prevSchedules = { ...newSchedules };

  // Sync pause state
  const configPaused = new Set(config.PAUSED_JOBS);
  const schedulerPaused = scheduler.pausedJobs();
  for (const name of configPaused) {
    if (!schedulerPaused.has(name)) scheduler.pauseJob(name);
  }
  for (const name of schedulerPaused) {
    if (!configPaused.has(name)) scheduler.resumeJob(name);
  }

  // Sync enabled jobs
  const newEnabled = new Set(config.ENABLED_JOBS);

  for (const name of newEnabled) {
    if (!prevEnabledJobs.has(name)) {
      const job = jobs.find(j => j.name === name);
      if (job) {
        scheduler.addJob(job);
        log.info(`Enabled job: ${name}`);
      }
    }
  }

  for (const name of prevEnabledJobs) {
    if (!newEnabled.has(name)) {
      scheduler.removeJob(name);
      log.info(`Disabled job: ${name}`);
    }
  }

  prevEnabledJobs = newEnabled;
});

// ── Discord bot ──

if (isDiscordConfigured()) {
  discord.start(scheduler).catch((err) => {
    log.error(`[discord] Failed to start: ${err}`);
    reportError("discord:start", "Discord bot failed to start", err).catch(() => {});
  });
  log.info("Discord bot enabled");
}

announceIfNewVersion(VERSION, WORK_DIR);

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  setShuttingDown();

  log.info("Shutting down...");
  clearInterval(pruneInterval);

  if (isDiscordConfigured()) {
    await discord.stop();
  }

  cancelQueuedTasks();
  await scheduler.drain(300_000);

  if (cancelCurrentTask()) {
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  server.close();
  closeDb();

  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

log.info("yeti is running");
