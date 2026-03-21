import type { Theme } from "./layout.js";
import { PAGE_CSS, escapeHtml, htmlOpenTag, buildNav, THEME_SCRIPT } from "./layout.js";
import { getConfigForDisplay } from "../config.js";
import * as config from "../config.js";

function isEnvOverridden(envVar: string): boolean {
  return process.env[envVar] !== undefined && process.env[envVar] !== "";
}

export function buildConfigPage(saved: boolean, theme: Theme): string {
  const cfg = getConfigForDisplay();

  const envMap: Record<string, string> = {
    slackWebhook: "YETI_SLACK_WEBHOOK",
    slackBotToken: "YETI_SLACK_BOT_TOKEN",
    slackIdeasChannel: "YETI_SLACK_IDEAS_CHANNEL",
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

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>yeti — config</title>
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

    <h2>Jobs &amp; Repos</h2>
    <label for="enabledJobs">Enabled Jobs (comma-separated)</label>
    <input type="text" name="enabledJobs" id="enabledJobs" value="${escapeHtml(Array.isArray(cfg.enabledJobs) ? (cfg.enabledJobs as string[]).join(", ") : "")}">
    <div class="field-note">Valid jobs: issue-refiner, issue-worker, ci-fixer, review-addresser, doc-maintainer, auto-merger, repo-standards, improvement-identifier, issue-auditor, triage-yeti-errors</div>
    <div class="field-note">Empty means no jobs will run.</div>

    <label for="allowedRepos">Allowed Repos (comma-separated short names)</label>
    <input type="text" name="allowedRepos" id="allowedRepos" value="${escapeHtml(Array.isArray(cfg.allowedRepos) ? (cfg.allowedRepos as string[]).join(", ") : "")}"${isDisabled("allowedRepos") ? " disabled" : ""}>
    ${envNote("allowedRepos")}
    <div class="field-note">Restricts which repos Yeti processes. Empty means no repos (use with caution). To allow all repos, remove the allowedRepos key from config.json.</div>

    <h2>Server</h2>
    <label for="port">Port</label>
    <input type="number" name="port" id="port" value="${Number(cfg.port)}" disabled>
    <div class="field-note">Read-only — requires restart to change</div>

    <h2>Integrations</h2>
    <label for="slackWebhook">Slack Webhook</label>
    <input type="password" name="slackWebhook" id="slackWebhook" placeholder="${escapeHtml(String(cfg.slackWebhook ?? ""))}"${isDisabled("slackWebhook") ? " disabled" : ""}>
    ${envNote("slackWebhook")}
    <div class="field-note">Leave empty to keep current value</div>

    <label for="slackBotToken">Slack Bot Token (Ideas)</label>
    <input type="password" name="slackBotToken" id="slackBotToken" placeholder="${escapeHtml(String(cfg.slackBotToken ?? ""))}"${isDisabled("slackBotToken") ? " disabled" : ""}>
    ${envNote("slackBotToken")}
    <div class="field-note">Leave empty to keep current value</div>

    <label for="slackIdeasChannel">Slack Ideas Channel ID</label>
    <input type="text" name="slackIdeasChannel" id="slackIdeasChannel" value="${escapeHtml(String(cfg.slackIdeasChannel ?? ""))}"${isDisabled("slackIdeasChannel") ? " disabled" : ""}>
    ${envNote("slackIdeasChannel")}

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
