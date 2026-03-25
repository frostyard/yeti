import type { Theme } from "./layout.js";
import { PAGE_CSS, htmlOpenTag, buildNav, THEME_SCRIPT, TOAST_SCRIPT, siteTitle, formatRelativeTime, formatCountdown } from "./layout.js";
import { msUntilHour } from "../scheduler.js";

const JOB_DESCRIPTIONS: Record<string, string> = {
  "issue-refiner": "Generates implementation plans for issues needing refinement",
  "plan-reviewer": "Adversarial AI review of generated implementation plans",
  "issue-worker": "Implements Refined issues as pull requests",
  "ci-fixer": "Fixes failing CI checks and resolves merge conflicts",
  "review-addresser": "Addresses review comments on Yeti pull requests",
  "triage-yeti-errors": "Investigates and triages internal Yeti error issues",
  "doc-maintainer": "Nightly documentation generation and updates",
  "auto-merger": "Auto-merges Dependabot and approved Yeti PRs",
  "repo-standards": "Syncs labels and cleans up legacy labels across repos",
  "improvement-identifier": "Identifies codebase improvements and implements as PRs",
  "mkdocs-update": "Daily MkDocs documentation update from recent changes",
  "issue-auditor": "Daily audit ensuring no issues fall between the cracks",
};

export interface JobInfo {
  name: string;
  intervalMs: number;
  scheduledHour?: number;
}

export function buildJobsPage(
  allJobs: JobInfo[],
  enabledJobs: ReadonlySet<string>,
  jobAi: Readonly<Record<string, { backend?: "claude" | "copilot" | "codex"; model?: string }>>,
  runningJobs: Record<string, boolean>,
  latestRuns: Map<string, { runId: string; status: string; startedAt: string; completedAt: string | null }>,
  theme: Theme,
  paused: Set<string>,
  scheduleInfo: Map<string, { intervalMs: number; scheduledHour?: number }>,
  username?: string | null,
): string {
  const jobRows = allJobs.map(job => {
    const { name } = job;
    const enabled = enabledJobs.has(name);
    const description = JOB_DESCRIPTIONS[name] ?? "";
    const ai = jobAi[name];
    const backend = ai?.backend ?? "claude";
    const model = ai?.model || "default";

    // Status — disabled jobs show "Disabled", enabled jobs show Running/Paused/Idle
    const isRunning = runningJobs[name] ?? false;
    const isPaused = paused.has(name);
    let statusClass: string;
    let statusText: string;
    if (!enabled) {
      statusClass = "idle";
      statusText = "Disabled";
    } else if (isRunning) {
      statusClass = "running";
      statusText = "Running";
    } else if (isPaused) {
      statusClass = "paused";
      statusText = "Paused";
    } else {
      statusClass = "idle";
      statusText = "Idle";
    }

    // Last Run
    const latest = latestRuns.get(name);
    let lastRunText = "\u2014";
    if (latest?.completedAt) {
      lastRunText = formatRelativeTime(latest.completedAt + "Z");
    } else if (latest?.startedAt) {
      lastRunText = formatRelativeTime(latest.startedAt + "Z");
    }

    // Next Run — use scheduler info for enabled jobs, static info for disabled
    let nextRunText = "\u2014";
    if (enabled && !isPaused) {
      const sched = scheduleInfo.get(name);
      if (sched?.scheduledHour !== undefined) {
        nextRunText = formatCountdown(msUntilHour(sched.scheduledHour));
      } else if (sched && latest?.startedAt) {
        const nextMs = new Date(latest.startedAt + "Z").getTime() + sched.intervalMs - Date.now();
        nextRunText = formatCountdown(Math.max(0, nextMs));
      } else if (sched) {
        nextRunText = formatCountdown(sched.intervalMs);
      }
    }

    // Schedule description (show for all jobs, even disabled)
    let scheduleText: string;
    if (job.scheduledHour !== undefined) {
      scheduleText = `Daily at ${job.scheduledHour}:00`;
    } else {
      const mins = Math.round(job.intervalMs / 60000);
      scheduleText = `Every ${mins} min`;
    }

    // Logs link
    const logsCell = latest
      ? `<a href="/logs/${encodeURIComponent(latest.runId)}"${latest.status === "running" ? ' class="running"' : ""}>${latest.status === "running" ? "Live" : "View"}</a>`
      : "";

    // Action buttons — only for enabled jobs
    const actions = enabled
      ? `<button class="trigger-btn" onclick="triggerJob('${name}', this)">Run</button> <button class="trigger-btn${isPaused ? " paused-btn" : ""}" id="pause-${name}" onclick="togglePause('${name}', this)">${isPaused ? "Resume" : "Pause"}</button>`
      : "";

    const enabledBadge = enabled
      ? `<span style="color:var(--success)">Enabled</span>`
      : `<span style="color:var(--text-subtle)">Disabled</span>`;

    const backendLabel = backend === "copilot" ? "Copilot" : backend === "codex" ? "Codex" : "Claude";

    return `<tr>
      <td>
        <div><strong>${name}</strong></div>
        <div style="font-size:0.8rem;color:var(--text-secondary)">${description}</div>
      </td>
      <td>${enabledBadge}</td>
      <td id="job-backend-${name}">${backendLabel}</td>
      <td id="job-model-${name}">${model}</td>
      <td>${scheduleText}</td>
      <td id="job-${name}" class="${statusClass}">${statusText}</td>
      <td id="job-lastrun-${name}">${lastRunText}</td>
      <td id="job-nextrun-${name}">${nextRunText}</td>
      <td id="job-logs-${name}">${logsCell}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${siteTitle("Jobs")}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <h1>Jobs</h1>
  ${buildNav(theme, username)}
  ${THEME_SCRIPT}${TOAST_SCRIPT}
  <table>
    <thead><tr><th>Job</th><th></th><th>Backend</th><th>Model</th><th>Schedule</th><th>Status</th><th>Last Run</th><th>Next Run</th><th>Logs</th><th></th></tr></thead>
    <tbody>
      ${jobRows}
    </tbody>
  </table>
  <p class="refresh-note">Live-updating every 10s</p>
  <script>
    function triggerJob(name, btn) {
      btn.disabled = true;
      btn.textContent = '...';
      fetch('/trigger/' + encodeURIComponent(name), { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          btn.textContent = data.result === 'started' ? 'Triggered!' : 'Already running';
        })
        .catch(function() { btn.textContent = 'Error'; })
        .finally(function() { setTimeout(function() { btn.textContent = 'Run'; btn.disabled = false; }, 2000); });
    }
    function togglePause(name, btn) {
      btn.disabled = true;
      btn.textContent = '...';
      fetch('/pause/' + encodeURIComponent(name), { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          btn.textContent = data.result === 'paused' ? 'Paused!' : 'Resumed!';
        })
        .catch(function() { btn.textContent = 'Error'; })
        .finally(function() { setTimeout(function() { location.reload(); }, 1000); });
    }
    function formatRelativeTime(iso) {
      if (!iso) return '';
      var ms = Date.now() - Date.parse(iso);
      if (ms < 0) return 'just now';
      var secs = Math.floor(ms / 1000);
      if (secs < 60) return secs + 's ago';
      var mins = Math.floor(secs / 60);
      if (mins < 60) return mins + 'm ago';
      var hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      var days = Math.floor(hours / 24);
      return days + 'd ago';
    }
    function formatCountdown(ms) {
      if (ms <= 0) return 'soon';
      var secs = Math.floor(ms / 1000);
      var mins = Math.floor(secs / 60);
      var hours = Math.floor(mins / 60);
      if (hours > 0) return 'in ' + hours + 'h ' + (mins % 60) + 'm';
      if (mins > 0) return 'in ' + mins + 'm';
      return 'in ' + secs + 's';
    }
    setInterval(function() {
      fetch('/status')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var pausedSet = {};
          if (data.pausedJobs) data.pausedJobs.forEach(function(n) { pausedSet[n] = true; });
          Object.keys(data.jobs).forEach(function(name) {
            var el = document.getElementById('job-' + name);
            if (el) {
              if (data.jobs[name]) {
                el.textContent = 'Running'; el.className = 'running';
              } else if (pausedSet[name]) {
                el.textContent = 'Paused'; el.className = 'paused';
              } else {
                el.textContent = 'Idle'; el.className = 'idle';
              }
            }
            var pauseBtn = document.getElementById('pause-' + name);
            if (pauseBtn) {
              pauseBtn.textContent = pausedSet[name] ? 'Resume' : 'Pause';
              pauseBtn.className = pausedSet[name] ? 'trigger-btn paused-btn' : 'trigger-btn';
            }
          });
          if (data.jobSchedules) {
            Object.keys(data.jobSchedules).forEach(function(name) {
              var info = data.jobSchedules[name];
              var lr = document.getElementById('job-lastrun-' + name);
              if (lr) lr.textContent = info.lastCompletedAt ? formatRelativeTime(info.lastCompletedAt) : '\u2014';
              var nr = document.getElementById('job-nextrun-' + name);
              if (nr) nr.textContent = info.nextRunIn !== null ? formatCountdown(info.nextRunIn) : '\u2014';
            });
          }
          if (data.jobAi) {
            document.querySelectorAll('[id^="job-backend-"]').forEach(function(el) {
              var name = el.id.replace('job-backend-', '');
              var ai = data.jobAi[name];
              var backend = ai && ai.backend ? ai.backend : 'claude';
              el.textContent = backend === 'copilot' ? 'Copilot' : backend === 'codex' ? 'Codex' : 'Claude';
            });
            document.querySelectorAll('[id^="job-model-"]').forEach(function(el) {
              var name = el.id.replace('job-model-', '');
              var ai = data.jobAi[name];
              el.textContent = ai && ai.model ? ai.model : 'default';
            });
          }
        })
        .catch(function() {});
    }, 10000);
  </script>
</body>
</html>`;
}
