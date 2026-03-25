import type { NotificationRow } from "../db.js";
import { PAGE_CSS, buildNav, htmlOpenTag, siteTitle, THEME_SCRIPT, TOAST_SCRIPT, escapeHtml, formatRelativeTime } from "./layout.js";

export type Theme = "system" | "light" | "dark";

export function buildNotificationsPage(
  notifications: NotificationRow[],
  theme: Theme,
  username?: string | null,
): string {
  let body: string;
  if (notifications.length === 0) {
    body = `<p class="empty">No notifications yet.</p>`;
  } else {
    const rows = notifications.map(n => {
      const link = n.url
        ? `<a href="${escapeHtml(n.url)}" target="_blank">${escapeHtml(n.message)}</a>`
        : escapeHtml(n.message);
      return `<tr class="level-${escapeHtml(n.level)}">
        <td>${formatRelativeTime(n.created_at)}</td>
        <td>${escapeHtml(n.job_name)}</td>
        <td>${link}</td>
        <td>${escapeHtml(n.level)}</td>
      </tr>`;
    }).join("");
    body = `<table><thead><tr><th>Time</th><th>Job</th><th>Message</th><th>Level</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head><title>${siteTitle("Notifications")}</title><style>${PAGE_CSS}</style></head>
<body>
<h1>yeti</h1>
${buildNav(theme, username)}
<h2>Notifications</h2>
${body}
${THEME_SCRIPT}${TOAST_SCRIPT}
</body></html>`;
}
