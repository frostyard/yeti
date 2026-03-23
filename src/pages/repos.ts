import type { Theme } from "./layout.js";
import { PAGE_CSS, escapeHtml, htmlOpenTag, buildNav, THEME_SCRIPT, siteTitle, itemLogsUrl, formatRelativeTime } from "./layout.js";
import type { QueueItem, QueueCategory } from "../github.js";
import type { Repo } from "../config.js";
import type { Task } from "../db.js";

const CATEGORY_LABELS: Record<QueueCategory, string> = {
  "ready": "Ready",
  "needs-refinement": "Needs Refinement",
  "refined": "Refined",
  "needs-review-addressing": "Needs Review Addressing",
  "auto-mergeable": "Auto-Mergeable",
  "needs-triage": "Needs Triage",
  "needs-plan-review": "Needs Plan Review",
};

const CATEGORY_COLORS: Record<QueueCategory, string> = {
  "ready": "0e8a16",
  "needs-refinement": "d876e3",
  "refined": "0075ca",
  "needs-review-addressing": "e4e669",
  "auto-mergeable": "0e8a16",
  "needs-triage": "d73a49",
  "needs-plan-review": "c5def5",
};

function statusBadge(category: QueueCategory): string {
  const label = CATEGORY_LABELS[category] ?? category;
  const color = CATEGORY_COLORS[category] ?? "30363d";
  const bg = `#${color}`;
  const text = parseInt(color, 16) > 0x7fffff ? "#000" : "#fff";
  return `<span class="repo-badge" style="background:${bg};color:${text}">${escapeHtml(label)}</span>`;
}

function checkBadge(status?: "passing" | "failing" | "pending"): string {
  if (status === "passing") return `<span class="check check-pass">&#x2714;</span>`;
  if (status === "failing") return `<span class="check check-fail">&#x2718;</span>`;
  if (status === "pending") return `<span class="check check-pending">&#x25CB;</span>`;
  return "";
}

function buildItemRow(item: QueueItem): string {
  const displayNumber = item.prNumber ?? item.number;
  const ghUrl = item.type === "pr"
    ? `https://github.com/${item.repo}/pull/${displayNumber}`
    : `https://github.com/${item.repo}/issues/${item.number}`;
  const logsUrl = itemLogsUrl(item.repo, displayNumber);
  const typeLabel = item.type === "pr" ? "PR" : "Issue";

  let html = `<div class="repo-item">`;
  html += `<span class="type-badge">${typeLabel}</span>`;
  html += checkBadge(item.checkStatus);
  html += `<a class="number" href="${logsUrl}">#${displayNumber}</a>`;
  html += `<span class="title">${escapeHtml(item.title)}</span>`;
  html += statusBadge(item.category);
  html += `<a href="${escapeHtml(ghUrl)}" class="gh-link" target="_blank">GitHub</a>`;
  html += `</div>`;
  return html;
}

function buildCompletedRow(task: Task): string {
  const ghUrl = `https://github.com/${task.repo}/issues/${task.item_number}`;
  const logsUrl = itemLogsUrl(task.repo, task.item_number);
  const timeAgo = task.completed_at ? formatRelativeTime(task.completed_at + "Z") : "";

  let html = `<div class="repo-item completed-item">`;
  html += `<span class="type-badge">${escapeHtml(task.job_name)}</span>`;
  html += `<a class="number" href="${logsUrl}">#${task.item_number}</a>`;
  html += `<span class="title">${escapeHtml(task.repo.split("/").pop() ?? task.repo)}</span>`;
  html += `<span class="time">${timeAgo}</span>`;
  html += `<a href="${escapeHtml(ghUrl)}" class="gh-link" target="_blank">GitHub</a>`;
  html += `</div>`;
  return html;
}

export interface ReposPageData {
  repos: Repo[];
  queueItems: QueueItem[];
  recentTasks: Task[];
  availableRepos: Repo[];
  allowedReposIsNull: boolean;
  theme: Theme;
}

export function buildReposPage(data: ReposPageData): string {
  const { repos, queueItems, recentTasks, availableRepos, allowedReposIsNull, theme } = data;

  // Group queue items by repo
  const activeByRepo = new Map<string, QueueItem[]>();
  for (const item of queueItems) {
    const list = activeByRepo.get(item.repo) ?? [];
    list.push(item);
    activeByRepo.set(item.repo, list);
  }

  // Group completed tasks by repo
  const completedByRepo = new Map<string, Task[]>();
  for (const task of recentTasks) {
    const list = completedByRepo.get(task.repo) ?? [];
    list.push(task);
    completedByRepo.set(task.repo, list);
  }

  const activeRepoCount = new Set([...activeByRepo.keys()]).size;

  // Summary
  let summaryHtml = `<dl class="meta">`;
  summaryHtml += `<dt>Configured Repos</dt><dd>${repos.length}</dd>`;
  summaryHtml += `<dt>Active Repos</dt><dd>${activeRepoCount}</dd>`;
  summaryHtml += `</dl>`;

  // Add Repo button / dialog
  let addRepoHtml = "";
  if (allowedReposIsNull) {
    addRepoHtml = `<p class="repo-note">All org repos are included (no allowedRepos filter is set).</p>`;
  } else if (availableRepos.length === 0) {
    addRepoHtml = `<button class="trigger-btn" disabled>Add Repo (none available)</button>`;
  } else {
    let dialogOptions = "";
    for (const repo of availableRepos) {
      dialogOptions += `<label class="dialog-option"><input type="radio" name="repo" value="${escapeHtml(repo.name)}"> ${escapeHtml(repo.fullName)}</label>`;
    }
    addRepoHtml = `<button class="trigger-btn" onclick="document.getElementById('add-repo-dialog').showModal()">Add Repo</button>
    <dialog id="add-repo-dialog">
      <h2>Add Repository</h2>
      <form method="dialog" id="add-repo-form">
        <div class="dialog-options">${dialogOptions}</div>
        <div class="dialog-actions">
          <button type="button" class="trigger-btn" onclick="addRepo()">Add</button>
          <button type="button" class="trigger-btn" onclick="document.getElementById('add-repo-dialog').close()">Cancel</button>
        </div>
      </form>
    </dialog>`;
  }

  // Repo detail sections
  let repoDetailsHtml = "";
  for (const repo of repos) {
    const active = activeByRepo.get(repo.fullName) ?? [];
    const completed = completedByRepo.get(repo.fullName) ?? [];

    repoDetailsHtml += `<div class="repo-section">`;
    repoDetailsHtml += `<div class="repo-header">`;
    repoDetailsHtml += `<h2>${escapeHtml(repo.fullName)}</h2>`;
    repoDetailsHtml += `<span class="repo-links">`;
    repoDetailsHtml += `<a href="https://github.com/${escapeHtml(repo.fullName)}/issues" target="_blank">Issues</a>`;
    repoDetailsHtml += ` <a href="https://github.com/${escapeHtml(repo.fullName)}/pulls" target="_blank">Pull Requests</a>`;
    repoDetailsHtml += `</span>`;
    repoDetailsHtml += `</div>`;

    if (active.length > 0) {
      repoDetailsHtml += `<h3>Active</h3>`;
      for (const item of active) {
        repoDetailsHtml += buildItemRow(item);
      }
    }

    if (completed.length > 0) {
      repoDetailsHtml += `<details class="completed-details"><summary>Recently Completed (${completed.length})</summary>`;
      for (const task of completed) {
        repoDetailsHtml += buildCompletedRow(task);
      }
      repoDetailsHtml += `</details>`;
    }

    if (active.length === 0 && completed.length === 0) {
      repoDetailsHtml += `<p class="queue-empty">No active items</p>`;
    }

    repoDetailsHtml += `</div>`;
  }

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>${siteTitle("Repos")}</title>
  <style>${PAGE_CSS}
  .repo-section { margin-bottom: 2rem; border: 1px solid var(--border); border-radius: 6px; padding: 1rem; }
  .repo-header { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
  .repo-header h2 { margin: 0; }
  .repo-links { font-size: 0.85rem; }
  .repo-links a { margin-right: 0.75rem; }
  .repo-item { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.3rem 0; font-size: 0.85rem; border-bottom: 1px solid var(--border); }
  .repo-item .number { min-width: 3rem; }
  .repo-item .title { flex: 1; color: var(--text); }
  .repo-item .time { color: var(--text-subtle); font-size: 0.75rem; white-space: nowrap; }
  .repo-item .gh-link { font-size: 0.75rem; white-space: nowrap; }
  .repo-badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 12px; font-size: 0.7rem; font-weight: 600; white-space: nowrap; }
  .completed-item { opacity: 0.7; }
  .completed-details { margin-top: 0.5rem; }
  .completed-details summary { cursor: pointer; font-size: 0.85rem; color: var(--text-secondary); }
  h3 { font-size: 0.9rem; color: var(--text-secondary); margin: 0.75rem 0 0.25rem; }
  .repo-note { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem; }
  dialog { background: var(--bg-secondary); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; max-width: 400px; }
  dialog::backdrop { background: rgba(0,0,0,0.5); }
  dialog h2 { margin-bottom: 1rem; }
  .dialog-options { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; max-height: 300px; overflow-y: auto; }
  .dialog-option { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
  .dialog-option:hover { background: var(--btn-hover); }
  .dialog-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
  </style>
</head>
<body>
  ${buildNav(theme)}
  ${THEME_SCRIPT}
  <h1>Repos</h1>
  ${summaryHtml}
  ${addRepoHtml}
  ${repoDetailsHtml}
  <script>
    function addRepo() {
      var selected = document.querySelector('#add-repo-form input[name="repo"]:checked');
      if (!selected) return;
      var btn = document.querySelector('.dialog-actions button');
      btn.disabled = true;
      btn.textContent = 'Adding...';
      fetch('/repos/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: selected.value })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.error) {
          btn.textContent = 'Error';
          setTimeout(function() { btn.textContent = 'Add'; btn.disabled = false; }, 3000);
        } else {
          window.location.reload();
        }
      }).catch(function() {
        btn.textContent = 'Error';
        setTimeout(function() { btn.textContent = 'Add'; btn.disabled = false; }, 3000);
      });
    }
  </script>
</body>
</html>`;
}
