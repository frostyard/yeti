import type { Theme } from "./layout.js";
import { PAGE_CSS, escapeHtml, repoShortName, itemLogsUrl, formatUptime, formatRelativeTime, formatCountdown, htmlOpenTag, buildNav, THEME_SCRIPT, TOAST_SCRIPT, discordLabel, siteTitle } from "./layout.js";
import { msUntilHour } from "../scheduler.js";
import { isGitHubAppConfigured, getAppSlug } from "../github-app.js";
import { WEBHOOK_SECRET } from "../config.js";

interface RunningTaskInfo {
  jobName: string;
  repo: string;
  itemNumber: number;
  startedAt: string;
}

export function buildStatusPage(
  version: string,
  uptime: number,
  jobs: Record<string, boolean>,
  queue: { pending: number; active: number },
  discord: { configured: boolean; connected: boolean; lastResult: "ok" | "error" | null },
  runningTasks: RunningTaskInfo[],
  latestRuns: Map<string, { runId: string; status: string; startedAt: string; completedAt: string | null }>,
  theme: Theme,
  startedAt: string,
  paused?: Set<string>,
  scheduleInfo?: Map<string, { intervalMs: number; scheduledHour?: number }>,
  copilotQueue?: { pending: number; active: number },
  codexQueue?: { pending: number; active: number },
  username?: string | null,
): string {
  const dc = discordLabel(discord);
  const githubAuthLabel = isGitHubAppConfigured()
    ? `App${getAppSlug() ? ` (${escapeHtml(getAppSlug()!)}[bot])` : ""}`
    : "Personal (gh CLI)";

  // Build a map of job name → running task detail for the jobs table
  const taskByJob = new Map<string, RunningTaskInfo>();
  for (const t of runningTasks) {
    taskByJob.set(t.jobName, t);
  }

  const workingOnTasks = queue.active > 0 ? runningTasks : [];
  const workingOnHtml = workingOnTasks.length > 0
    ? `<dt>Working on</dt>
    <dd id="queue-working-on">${workingOnTasks.map(t =>
      `${escapeHtml(t.jobName)} &mdash; ${t.itemNumber > 0
        ? `${escapeHtml(repoShortName(t.repo))} <a href="${itemLogsUrl(t.repo, t.itemNumber)}">#${t.itemNumber}</a>`
        : escapeHtml(repoShortName(t.repo))}`
    ).join("<br>")}</dd>`
    : `<dt>Working on</dt>
    <dd id="queue-working-on" class="idle">&mdash;</dd>`;

  const cancelBtnHtml = queue.active > 0
    ? `<dt></dt><dd><button class="trigger-btn" onclick="cancelTask(this)" id="cancel-btn">Cancel</button></dd>`
    : `<dt></dt><dd><button class="trigger-btn" onclick="cancelTask(this)" id="cancel-btn" style="display:none">Cancel</button></dd>`;

  const pausedSet = paused ?? new Set<string>();

  const schedules = scheduleInfo ?? new Map<string, { intervalMs: number; scheduledHour?: number }>();

  const jobRows = Object.entries(jobs)
    .map(
      ([name, running]) => {
        const task = taskByJob.get(name);
        const detail = task
          ? task.itemNumber > 0
            ? `${escapeHtml(repoShortName(task.repo))} <a href="${itemLogsUrl(task.repo, task.itemNumber)}">#${task.itemNumber}</a>`
            : escapeHtml(repoShortName(task.repo))
          : "";
        const latest = latestRuns.get(name);
        const logsCell = latest
          ? `<a href="/logs/${encodeURIComponent(latest.runId)}"${latest.status === "running" ? ' class="running"' : ""}>${latest.status === "running" ? "Live" : "View"}</a>`
          : "";
        const isPaused = pausedSet.has(name);
        const statusClass = running ? "running" : isPaused ? "paused" : "idle";
        const statusText = running ? "Running" : isPaused ? "Paused" : "Idle";

        // Last Run column
        let lastRunText = "\u2014";
        if (latest?.completedAt) {
          lastRunText = formatRelativeTime(latest.completedAt + "Z");
        } else if (latest?.startedAt) {
          lastRunText = formatRelativeTime(latest.startedAt + "Z");
        }

        // Next Run column
        let nextRunText = "\u2014";
        if (!isPaused) {
          const sched = schedules.get(name);
          if (sched?.scheduledHour !== undefined) {
            nextRunText = formatCountdown(msUntilHour(sched.scheduledHour));
          } else if (sched && latest?.startedAt) {
            const nextMs = new Date(latest.startedAt + "Z").getTime() + sched.intervalMs - Date.now();
            nextRunText = formatCountdown(Math.max(0, nextMs));
          } else if (sched) {
            nextRunText = formatCountdown(sched.intervalMs);
          }
        }

        return `<tr>
          <td>${name}</td>
          <td id="job-${name}" class="${statusClass}">${statusText}</td>
          <td id="job-lastrun-${name}">${lastRunText}</td>
          <td id="job-nextrun-${name}">${nextRunText}</td>
          <td id="job-detail-${name}">${detail}</td>
          <td id="job-logs-${name}">${logsCell}</td>
          <td><button class="trigger-btn" onclick="triggerJob('${name}', this)">Run</button> <button class="trigger-btn${isPaused ? " paused-btn" : ""}" id="pause-${name}" onclick="togglePause('${name}', this)">${isPaused ? "Resume" : "Pause"}</button></td>
        </tr>`;
      },
    )
    .join("\n");

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${siteTitle()}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <h1>yeti</h1>
  ${buildNav(theme, username)}
  ${THEME_SCRIPT}${TOAST_SCRIPT}
  <dl class="meta">
    <dt>Version</dt>
    <dd>${version}</dd>
    <dt>Uptime</dt>
    <dd id="uptime">${formatUptime(uptime)}</dd>
    <dt>Started</dt>
    <dd>${startedAt}</dd>
  </dl>
  <h2>Claude Queue</h2>
  <dl class="meta">
    <dt>Status</dt>
    <dd id="queue-status" class="${queue.active > 0 ? "running" : "idle"}">${queue.active > 0 ? `Active (${queue.active})` : "Idle"}</dd>
    <dt>Pending</dt>
    <dd id="queue-pending">${queue.pending}</dd>
    ${workingOnHtml}
    ${cancelBtnHtml}
  </dl>
  ${copilotQueue ? `<h2>Copilot Queue</h2>
  <dl class="meta">
    <dt>Status</dt>
    <dd id="copilot-queue-status" class="${copilotQueue.active > 0 ? "running" : "idle"}">${copilotQueue.active > 0 ? `Active (${copilotQueue.active})` : "Idle"}</dd>
    <dt>Pending</dt>
    <dd id="copilot-queue-pending">${copilotQueue.pending}</dd>
  </dl>` : ""}
  ${codexQueue ? `<h2>Codex Queue</h2>
  <dl class="meta">
    <dt>Status</dt>
    <dd id="codex-queue-status" class="${codexQueue.active > 0 ? "running" : "idle"}">${codexQueue.active > 0 ? `Active (${codexQueue.active})` : "Idle"}</dd>
    <dt>Pending</dt>
    <dd id="codex-queue-pending">${codexQueue.pending}</dd>
  </dl>` : ""}
  <h2>Integrations</h2>
  <dl class="meta">
    <dt>GitHub Auth</dt>
    <dd>${githubAuthLabel}</dd>
    <dt>Webhooks</dt>
    <dd>${WEBHOOK_SECRET ? "Active" : "Not configured"}</dd>
    <dt>Discord</dt>
    <dd id="discord-status" class="${dc.cls}">${dc.text}</dd>
  </dl>
  <h2>Jobs</h2>
  <table>
    <thead><tr><th>Job</th><th>Status</th><th>Last Run</th><th>Next Run</th><th>Current Task</th><th>Logs</th><th></th></tr></thead>
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
    function cancelTask(btn) {
      btn.disabled = true;
      btn.textContent = '...';
      fetch('/cancel', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          btn.textContent = data.result === 'cancelled' ? 'Cancelled!' : 'Nothing to cancel';
        })
        .catch(function() { btn.textContent = 'Error'; })
        .finally(function() { setTimeout(function() { btn.textContent = 'Cancel'; btn.disabled = false; }, 2000); });
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
    function repoShortName(fullName) {
      var i = fullName.indexOf('/');
      return i >= 0 ? fullName.slice(i + 1) : fullName;
    }
    function formatUptime(seconds) {
      var d = Math.floor(seconds / 86400);
      var h = Math.floor((seconds % 86400) / 3600);
      var m = Math.floor((seconds % 3600) / 60);
      var s = seconds % 60;
      var parts = [];
      if (d > 0) parts.push(d + 'd');
      if (h > 0) parts.push(h + 'h');
      if (m > 0) parts.push(m + 'm');
      parts.push(s + 's');
      return parts.join(' ');
    }
    setInterval(function() {
      fetch('/status')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          document.getElementById('uptime').textContent = formatUptime(data.uptime);
          var qs = document.getElementById('queue-status');
          qs.textContent = data.claudeQueue.active > 0 ? 'Active (' + data.claudeQueue.active + ')' : 'Idle';
          qs.className = data.claudeQueue.active > 0 ? 'running' : 'idle';
          document.getElementById('queue-pending').textContent = data.claudeQueue.pending;
          var wo = document.getElementById('queue-working-on');
          if (data.claudeQueue.active > 0 && data.runningTasks && data.runningTasks.length > 0) {
            wo.innerHTML = data.runningTasks.map(function(t) {
              return t.jobName + ' \u2014 ' + (t.itemNumber > 0
                ? repoShortName(t.repo) + ' <a href="/logs/issue?repo=' + encodeURIComponent(t.repo) + '&number=' + t.itemNumber + '">#' + t.itemNumber + '</a>'
                : repoShortName(t.repo));
            }).join('<br>');
            wo.className = '';
          } else {
            wo.innerHTML = '\u2014';
            wo.className = 'idle';
          }
          var cb = document.getElementById('cancel-btn');
          if (cb) cb.style.display = data.claudeQueue.active > 0 ? '' : 'none';
          if (data.copilotQueue) {
            var cqs = document.getElementById('copilot-queue-status');
            if (cqs) { cqs.textContent = data.copilotQueue.active > 0 ? 'Active (' + data.copilotQueue.active + ')' : 'Idle'; cqs.className = data.copilotQueue.active > 0 ? 'running' : 'idle'; }
            var cqp = document.getElementById('copilot-queue-pending');
            if (cqp) cqp.textContent = data.copilotQueue.pending;
          }
          if (data.codexQueue) {
            var xqs = document.getElementById('codex-queue-status');
            if (xqs) { xqs.textContent = data.codexQueue.active > 0 ? 'Active (' + data.codexQueue.active + ')' : 'Idle'; xqs.className = data.codexQueue.active > 0 ? 'running' : 'idle'; }
            var xqp = document.getElementById('codex-queue-pending');
            if (xqp) xqp.textContent = data.codexQueue.pending;
          }
          var taskByJob = {};
          if (data.runningTasks) {
            data.runningTasks.forEach(function(t) { taskByJob[t.jobName] = t; });
          }
          var dc = document.getElementById('discord-status');
          if (data.discord) {
            if (!data.discord.configured) { dc.textContent = 'Not configured'; dc.className = 'idle'; }
            else if (!data.discord.connected) { dc.textContent = 'Disconnected'; dc.className = 'status-error'; }
            else if (data.discord.lastResult === 'error') { dc.textContent = 'Error'; dc.className = 'status-error'; }
            else if (data.discord.lastResult === 'ok') { dc.textContent = 'Connected'; dc.className = 'running'; }
            else { dc.textContent = 'Connected (untested)'; dc.className = 'status-untested'; }
          }
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
            var det = document.getElementById('job-detail-' + name);
            if (det) {
              var task = taskByJob[name];
              det.innerHTML = task
                ? (task.itemNumber > 0
                  ? repoShortName(task.repo) + ' <a href="/logs/issue?repo=' + encodeURIComponent(task.repo) + '&number=' + task.itemNumber + '">#' + task.itemNumber + '</a>'
                  : repoShortName(task.repo))
                : '';
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
        })
        .catch(function() {});
    }, 10000);
  </script>
</body>
</html>`;
}
