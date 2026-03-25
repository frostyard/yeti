import type { NotificationRow } from "../db.js";
import { PAGE_CSS, buildNav, htmlOpenTag, siteTitle, THEME_SCRIPT, escapeHtml, formatRelativeTime } from "./layout.js";

export type Theme = "system" | "light" | "dark";

export function buildNotificationsPage(
  notifications: NotificationRow[],
  theme: Theme,
  username?: string | null,
): string {
  return `<!DOCTYPE html>${htmlOpenTag(theme)}<head><title>${siteTitle("Notifications")}</title><style>${PAGE_CSS}</style></head><body><h1>yeti</h1>${buildNav(theme, username)}<h2>Notifications</h2><p>Coming soon</p>${THEME_SCRIPT}</body></html>`;
}
