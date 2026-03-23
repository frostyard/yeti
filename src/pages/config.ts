import type { Theme } from "./layout.js";
import { PAGE_CSS, escapeHtml, htmlOpenTag, buildNav, THEME_SCRIPT, siteTitle } from "./layout.js";
import { getConfigForDisplay } from "../config.js";
import * as config from "../config.js";

function isEnvOverridden(envVar: string): boolean {
  return process.env[envVar] !== undefined && process.env[envVar] !== "";
}

export function buildConfigPage(saved: boolean, theme: Theme): string {
  const cfg = getConfigForDisplay();

  const envMap: Record<string, string> = {
    allowedRepos: "YETI_ALLOWED_REPOS",
    githubOwners: "YETI_GITHUB_OWNERS",
    selfRepo: "YETI_SELF_REPO",
    port: "PORT",
    discordBotToken: "YETI_DISCORD_BOT_TOKEN",
    discordChannelId: "YETI_DISCORD_CHANNEL_ID",
    discordAllowedUsers: "YETI_DISCORD_ALLOWED_USERS",
    authToken: "YETI_AUTH_TOKEN",
  };

  function envNote(key: string): string {
    const envVar = envMap[key];
    if (envVar && isEnvOverridden(envVar)) {
      return `<div class="env-note">Set via environment variable ${escapeHtml(envVar)}</div>`;
    }
    return "";
  }

  function isDisabled(key: string): boolean {
    const envVar = envMap[key];
    return !!(envVar && isEnvOverridden(envVar));
  }

  const intervals = cfg.intervals as Record<string, number>;
  const schedules = cfg.schedules as Record<string, number>;
  const authDisabled = !config.AUTH_TOKEN;
  const queueScanMinutes = Math.round(Number(cfg.queueScanIntervalMs ?? 300000) / 60000);

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${siteTitle("config")}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <h1>yeti</h1>
  ${buildNav(theme)}
  ${THEME_SCRIPT}
  ${saved ? '<div class="banner">Configuration saved and applied.</div>' : ""}
  ${authDisabled ? '<div class="warning-banner">Authentication is disabled. Set an auth token to protect this interface.</div>' : ""}
  <form method="POST" action="/config" class="config-form">
    <h2>General</h2>
    <label for="githubOwners">GitHub Owners (comma-separated)</label>
    <input type="text" name="githubOwners" id="githubOwners" value="${escapeHtml(Array.isArray(cfg.githubOwners) ? (cfg.githubOwners as string[]).join(", ") : "")}"${isDisabled("githubOwners") ? " disabled" : ""}>
    ${envNote("githubOwners")}

    <label for="selfRepo">Self Repo</label>
    <input type="text" name="selfRepo" id="selfRepo" value="${escapeHtml(String(cfg.selfRepo ?? ""))}"${isDisabled("selfRepo") ? " disabled" : ""}>
    ${envNote("selfRepo")}

    <label for="logRetentionDays">Log Retention (days)</label>
    <input type="number" name="logRetentionDays" id="logRetentionDays" value="${Number(cfg.logRetentionDays)}" min="1">

    <label for="logRetentionPerJob">Min Logs Kept Per Job</label>
    <input type="number" name="logRetentionPerJob" id="logRetentionPerJob" value="${Number(cfg.logRetentionPerJob)}" min="0">

    <label for="queueScanIntervalMs">Queue Scan Interval (minutes)</label>
    <input type="number" name="queueScanIntervalMs" id="queueScanIntervalMs" value="${queueScanMinutes}" min="1">
    <div class="field-note">How often the dashboard queue refreshes from GitHub labels (default: 5 min). Infrastructure — always runs regardless of enabled jobs.</div>

    <h2>Jobs &amp; Repos</h2>
    <label for="enabledJobs">Enabled Jobs (comma-separated)</label>
    <input type="text" name="enabledJobs" id="enabledJobs" value="${escapeHtml(Array.isArray(cfg.enabledJobs) ? (cfg.enabledJobs as string[]).join(", ") : "")}">
    <div class="field-note">Valid jobs: issue-refiner, issue-worker, ci-fixer, review-addresser, doc-maintainer, auto-merger, repo-standards, improvement-identifier, issue-auditor, triage-yeti-errors, plan-reviewer, mkdocs-update</div>
    <div class="field-note">Empty means no jobs will run.</div>

    <label for="allowedRepos">Allowed Repos (comma-separated short names)</label>
    <input type="text" name="allowedRepos" id="allowedRepos" value="${escapeHtml(Array.isArray(cfg.allowedRepos) ? (cfg.allowedRepos as string[]).join(", ") : "")}"${isDisabled("allowedRepos") ? " disabled" : ""}>
    ${envNote("allowedRepos")}
    <div class="field-note">Restricts which repos Yeti processes. Empty means no repos (use with caution). To allow all repos, remove the allowedRepos key from config.json.</div>

    <h2>Server</h2>
    <label for="port">Port</label>
    <input type="number" name="port" id="port" value="${Number(cfg.port)}" disabled>
    <div class="field-note">Read-only — requires restart to change</div>

    <h2>Discord</h2>
    <label for="discordBotToken">Discord Bot Token</label>
    <input type="password" name="discordBotToken" id="discordBotToken" placeholder="${escapeHtml(String(cfg.discordBotToken ?? ""))}"${isDisabled("discordBotToken") ? " disabled" : ""}>
    ${envNote("discordBotToken")}
    <div class="field-note">Leave empty to keep current value. Requires restart.</div>

    <label for="discordChannelId">Discord Channel ID</label>
    <input type="text" name="discordChannelId" id="discordChannelId" value="${escapeHtml(String(cfg.discordChannelId ?? ""))}"${isDisabled("discordChannelId") ? " disabled" : ""}>
    ${envNote("discordChannelId")}
    <div class="field-note">Requires restart</div>

    <label for="discordAllowedUsers">Discord Allowed Users (comma-separated IDs)</label>
    <input type="text" name="discordAllowedUsers" id="discordAllowedUsers" value="${escapeHtml(Array.isArray(cfg.discordAllowedUsers) ? (cfg.discordAllowedUsers as string[]).join(", ") : "")}"${isDisabled("discordAllowedUsers") ? " disabled" : ""}>
    ${envNote("discordAllowedUsers")}

    <h2>Intervals (minutes)</h2>
    ${Object.entries(intervals).map(([key, value]) =>
      `<label for="${escapeHtml(key)}">${escapeHtml(key.replace(/Ms$/, ""))}</label>
      <input type="number" name="interval_${escapeHtml(key)}" id="${escapeHtml(key)}" value="${Math.round(value / 60000)}" min="1">`
    ).join("\n    ")}

    <h2>Schedules (hour, 0-23)</h2>
    ${Object.entries(schedules).map(([key, value]) =>
      `<label for="${escapeHtml(key)}">${escapeHtml(key.replace(/Hour$/, ""))}</label>
      <input type="number" name="schedule_${escapeHtml(key)}" id="${escapeHtml(key)}" value="${value}" min="0" max="23">`
    ).join("\n    ")}

    <h2>AI Backends</h2>
    <label for="maxCopilotWorkers">Max Copilot Workers</label>
    <input type="number" name="maxCopilotWorkers" id="maxCopilotWorkers" value="${Number(cfg.maxCopilotWorkers ?? 1)}" min="0">
    <div class="field-note">Number of concurrent Copilot CLI processes (0 to disable)</div>

    <label for="copilotTimeoutMs">Copilot Timeout (minutes)</label>
    <input type="number" name="copilotTimeoutMs" id="copilotTimeoutMs" value="${Math.round(Number(cfg.copilotTimeoutMs ?? 1200000) / 60000)}" min="1">

    <label for="maxCodexWorkers">Max Codex Workers</label>
    <input type="number" name="maxCodexWorkers" id="maxCodexWorkers" value="${Number(cfg.maxCodexWorkers ?? 1)}" min="0">
    <div class="field-note">Number of concurrent Codex CLI processes (0 to disable)</div>

    <label for="codexTimeoutMs">Codex Timeout (minutes)</label>
    <input type="number" name="codexTimeoutMs" id="codexTimeoutMs" value="${Math.round(Number(cfg.codexTimeoutMs ?? 1200000) / 60000)}" min="1">

    <h3>Per-Job AI Config</h3>
    <div class="field-note">Override the AI backend and/or model for specific jobs. Leave model empty for default.</div>
    <table class="config-table">
      <thead><tr><th>Job</th><th>Backend</th><th>Model</th></tr></thead>
      <tbody>
        ${["issue-refiner", "issue-worker", "ci-fixer", "review-addresser", "doc-maintainer", "improvement-identifier", "plan-reviewer", "mkdocs-update"].map(job => {
          const jobCfg = (cfg.jobAi as Record<string, { backend?: string; model?: string }> | undefined)?.[job] ?? {};
          return `<tr>
            <td>${escapeHtml(job)}</td>
            <td><select name="jobAi_${escapeHtml(job)}_backend">
              <option value="claude"${!jobCfg.backend || jobCfg.backend === "claude" ? " selected" : ""}>claude</option>
              <option value="copilot"${jobCfg.backend === "copilot" ? " selected" : ""}>copilot</option>
              <option value="codex"${jobCfg.backend === "codex" ? " selected" : ""}>codex</option>
            </select></td>
            <td><input type="text" name="jobAi_${escapeHtml(job)}_model" value="${escapeHtml(jobCfg.model ?? "")}" placeholder="default"></td>
          </tr>`;
        }).join("\n        ")}
      </tbody>
    </table>

    <h2>Authentication</h2>
    <label for="authToken">Auth Token</label>
    <input type="password" name="authToken" id="authToken" placeholder="${escapeHtml(String(cfg.authToken ?? ""))}"${isDisabled("authToken") ? " disabled" : ""}>
    ${envNote("authToken")}
    <div class="field-note">Leave empty to keep current value</div>

    <button type="submit" class="save-btn">Save Configuration</button>
  </form>
</body>
</html>`;
}
