import type { Theme } from "./layout.js";
import { PAGE_CSS, escapeHtml, htmlOpenTag, buildNav, THEME_SCRIPT, siteTitle } from "./layout.js";
import { getConfigForDisplay, LOG_LEVELS } from "../config.js";
import * as config from "../config.js";
import { isOAuthConfigured } from "../oauth.js";

export const VALID_TABS = ["general", "scheduling", "ai", "integrations", "security"] as const;
export type TabId = (typeof VALID_TABS)[number];

const TAB_LABELS: Record<TabId, string> = {
  general: "General",
  scheduling: "Scheduling",
  ai: "AI Backends",
  integrations: "Integrations",
  security: "Security",
};

function isEnvOverridden(envVar: string, validator?: (value: string) => boolean): boolean {
  const val = process.env[envVar];
  if (val === undefined || val === "") return false;
  return validator ? validator(val) : true;
}

export function buildConfigPage(saved: boolean, theme: Theme, username?: string | null, activeTab?: string): string {
  const cfg = getConfigForDisplay();

  const tab: TabId = VALID_TABS.includes(activeTab as TabId) ? (activeTab as TabId) : "general";

  const envValidators: Record<string, (v: string) => boolean> = {
    logLevel: (v) => (LOG_LEVELS as readonly string[]).includes(v),
  };

  const envMap: Record<string, string> = {
    logLevel: "YETI_LOG_LEVEL",
    allowedRepos: "YETI_ALLOWED_REPOS",
    includeForks: "YETI_INCLUDE_FORKS",
    githubOwners: "YETI_GITHUB_OWNERS",
    selfRepo: "YETI_SELF_REPO",
    port: "PORT",
    discordBotToken: "YETI_DISCORD_BOT_TOKEN",
    discordChannelId: "YETI_DISCORD_CHANNEL_ID",
    discordAllowedUsers: "YETI_DISCORD_ALLOWED_USERS",
    authToken: "YETI_AUTH_TOKEN",
    githubAppId: "YETI_GITHUB_APP_ID",
    githubAppInstallationId: "YETI_GITHUB_APP_INSTALLATION_ID",
    githubAppPrivateKeyPath: "YETI_GITHUB_APP_PRIVATE_KEY_PATH",
    githubAppClientId: "YETI_GITHUB_APP_CLIENT_ID",
    githubAppClientSecret: "YETI_GITHUB_APP_CLIENT_SECRET",
    externalUrl: "YETI_EXTERNAL_URL",
    webhookSecret: "YETI_WEBHOOK_SECRET",
  };

  function envNote(key: string): string {
    const envVar = envMap[key];
    if (envVar && isEnvOverridden(envVar, envValidators[key])) {
      return `<div class="env-note">Set via environment variable ${escapeHtml(envVar)}</div>`;
    }
    if (envVar && process.env[envVar] && envValidators[key] && !envValidators[key](process.env[envVar]!)) {
      return `<div class="env-note" style="color:var(--warn,#b58900)">⚠ ${escapeHtml(envVar)} has invalid value "${escapeHtml(process.env[envVar]!)}" — ignored</div>`;
    }
    return "";
  }

  function isDisabled(key: string): boolean {
    const envVar = envMap[key];
    return !!(envVar && isEnvOverridden(envVar, envValidators[key]));
  }

  const intervals = cfg.intervals as Record<string, number>;
  const schedules = cfg.schedules as Record<string, number>;
  const authDisabled = !config.AUTH_TOKEN && !isOAuthConfigured();
  const queueScanMinutes = Math.round(Number(cfg.queueScanIntervalMs ?? 300000) / 60000);

  function panelAttrs(id: TabId): string {
    const hidden = id !== tab;
    return `class="${hidden ? "tab-panel tab-panel-hidden" : "tab-panel"}" role="tabpanel" aria-labelledby="config-tab-${id}" aria-hidden="${hidden}"`;
  }

  const tabBar = `<div class="tab-bar" role="tablist" aria-label="Configuration sections">${VALID_TABS.map(id =>
    `<button type="button" class="${id === tab ? "active" : ""}" role="tab" id="config-tab-${id}" aria-selected="${id === tab ? "true" : "false"}" aria-controls="tab-${id}" tabindex="${id === tab ? "0" : "-1"}" data-tab="${id}" onclick="switchTab('${id}')">${TAB_LABELS[id]}</button>`
  ).join("")}</div>`;

  const tabScript = `<script>function switchTab(id){document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.add('tab-panel-hidden');p.setAttribute('aria-hidden','true')});var el=document.getElementById('tab-'+id);if(el){el.classList.remove('tab-panel-hidden');el.setAttribute('aria-hidden','false')}document.querySelectorAll('.tab-bar button').forEach(function(b){b.classList.remove('active');b.setAttribute('aria-selected','false');b.setAttribute('tabindex','-1')});var btn=document.querySelector('.tab-bar button[data-tab=\"'+id+'\"]');if(btn){btn.classList.add('active');btn.setAttribute('aria-selected','true');btn.setAttribute('tabindex','0');btn.focus()}var h=document.querySelector('input[name=\"_tab\"]');if(h)h.value=id}</script>`;

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
  ${buildNav(theme, username)}
  ${THEME_SCRIPT}
  ${saved ? '<div class="banner">Configuration saved and applied.</div>' : ""}
  ${authDisabled ? '<div class="warning-banner">Authentication is disabled. Set an auth token to protect this interface.</div>' : ""}
  ${tabBar}
  <form method="POST" action="/config" class="config-form">
    <input type="hidden" name="_tab" value="${tab}">

    <div ${panelAttrs("general")} id="tab-general">
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

    <label for="logLevel">Log Level</label>
    <select name="logLevel" id="logLevel"${isDisabled("logLevel") ? " disabled" : ""}>
      ${LOG_LEVELS.map(l => `<option value="${l}"${cfg.logLevel === l ? " selected" : ""}>${l}</option>`).join("")}
    </select>
    ${envNote("logLevel")}
    <div class="field-note">Minimum log level for console and stored logs. Default: debug.</div>

    <label for="queueScanIntervalMs">Queue Scan Interval (minutes)</label>
    <input type="number" name="queueScanIntervalMs" id="queueScanIntervalMs" value="${queueScanMinutes}" min="1">
    <div class="field-note">How often the dashboard queue refreshes from GitHub labels (default: 5 min). Infrastructure — always runs regardless of enabled jobs.</div>

    <h2>Jobs &amp; Repos</h2>
    <label for="enabledJobs">Enabled Jobs (comma-separated)</label>
    <input type="text" name="enabledJobs" id="enabledJobs" value="${escapeHtml(Array.isArray(cfg.enabledJobs) ? (cfg.enabledJobs as string[]).join(", ") : "")}">
    <div class="field-note">Valid jobs: issue-refiner, issue-worker, ci-fixer, review-addresser, doc-maintainer, auto-merger, repo-standards, improvement-identifier, issue-auditor, triage-yeti-errors, plan-reviewer, prompt-evaluator, mkdocs-update</div>
    <div class="field-note">Empty means no jobs will run.</div>

    <label for="allowedRepos">Allowed Repos (comma-separated short names)</label>
    <input type="text" name="allowedRepos" id="allowedRepos" value="${escapeHtml(Array.isArray(cfg.allowedRepos) ? (cfg.allowedRepos as string[]).join(", ") : "")}"${isDisabled("allowedRepos") ? " disabled" : ""}>
    ${envNote("allowedRepos")}
    <div class="field-note">Restricts which repos Yeti processes. Empty means no repos (use with caution). To allow all repos, remove the allowedRepos key from config.json.</div>

    <label><input type="checkbox" name="includeForks" value="true" ${cfg.includeForks ? "checked" : ""}${isDisabled("includeForks") ? " disabled" : ""}> Include forked repositories in discovery</label>
    ${envNote("includeForks")}
    <div class="field-note">When enabled, forked repos in the org are discovered alongside source repos. Default: off.</div>

    <h2>Plan Review Loop</h2>
    <label><input type="checkbox" name="reviewLoop" value="true" ${cfg.reviewLoop ? "checked" : ""}> Enable plan review loop (reviewer can send plans back for re-refinement)</label>
    <div class="field-note">When enabled, the plan-reviewer can reject a plan and add Needs Refinement to trigger another refinement cycle. Default: off.</div>

    <label for="maxPlanRounds">Max Plan Review Rounds</label>
    <input type="number" name="maxPlanRounds" id="maxPlanRounds" value="${Number(cfg.maxPlanRounds ?? 3)}" min="1">
    <div class="field-note">Maximum plan&rarr;review cycles before falling through to human review (default: 3)</div>

    <h2>Server</h2>
    <label for="port">Port</label>
    <input type="number" name="port" id="port" value="${Number(cfg.port)}" disabled>
    <div class="field-note">Read-only — requires restart to change</div>
    </div>

    <div ${panelAttrs("scheduling")} id="tab-scheduling">
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
    </div>

    <div ${panelAttrs("ai")} id="tab-ai">
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
        ${["issue-refiner", "issue-worker", "ci-fixer", "review-addresser", "doc-maintainer", "improvement-identifier", "plan-reviewer", "prompt-evaluator", "mkdocs-update", "triage-yeti-errors", "discord"].map(job => {
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
    </div>

    <div ${panelAttrs("integrations")} id="tab-integrations">
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

    <h2>GitHub App (optional)</h2>
    <div class="field-note">Optional — gives Yeti a separate bot identity so humans can approve its PRs with branch protection. Edit these in <code>~/.yeti/config.json</code> and restart.</div>

    <label>App ID</label>
    <div class="readonly-value">${escapeHtml(String(cfg.githubAppId ?? "")) || "<em>Not configured</em>"}</div>
    ${envNote("githubAppId")}

    <label>Installation ID</label>
    <div class="readonly-value">${escapeHtml(String(cfg.githubAppInstallationId ?? "")) || "<em>Not configured</em>"}</div>
    ${envNote("githubAppInstallationId")}

    <label>Private Key Path</label>
    <div class="readonly-value">${escapeHtml(String(cfg.githubAppPrivateKeyPath ?? "")) || "<em>Not configured</em>"}</div>
    ${envNote("githubAppPrivateKeyPath")}

    <h2>OAuth (optional)</h2>
    <div class="field-note">Enables GitHub sign-in for the dashboard. Requires a GitHub App with OAuth configured. Edit these in <code>~/.yeti/config.json</code> and restart.</div>

    <label>Client ID</label>
    <div class="readonly-value">${escapeHtml(String(cfg.githubAppClientId ?? "")) || "<em>Not configured</em>"}</div>
    ${envNote("githubAppClientId")}

    <label>Client Secret</label>
    <div class="readonly-value">${escapeHtml(String(cfg.githubAppClientSecret ?? "")) || "<em>Not configured</em>"}</div>
    ${envNote("githubAppClientSecret")}

    <label>External URL</label>
    <div class="readonly-value">${escapeHtml(String(cfg.externalUrl ?? "")) || "<em>Not configured</em>"}</div>
    ${envNote("externalUrl")}

    <h2>Webhooks (optional)</h2>
    <div class="field-note">Enables near-real-time job triggers and dashboard updates via GitHub webhooks. Edit in <code>~/.yeti/config.json</code> and restart.</div>

    <label>Webhook Secret</label>
    <div class="readonly-value">${escapeHtml(String(cfg.webhookSecret ?? "")) || "<em>Not configured</em>"}</div>
    ${envNote("webhookSecret")}
    </div>

    <div ${panelAttrs("security")} id="tab-security">
    <h2>Authentication</h2>
    <label for="authToken">Auth Token</label>
    <input type="password" name="authToken" id="authToken" placeholder="${escapeHtml(String(cfg.authToken ?? ""))}"${isDisabled("authToken") ? " disabled" : ""}>
    ${envNote("authToken")}
    <div class="field-note">Leave empty to keep current value</div>
    </div>

    <button type="submit" class="save-btn">Save Configuration</button>
  </form>
  ${tabScript}
</body>
</html>`;
}
