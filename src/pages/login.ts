import type { Theme } from "./layout.js";
import { PAGE_CSS, htmlOpenTag, THEME_SCRIPT, siteTitle } from "./layout.js";

interface LoginPageOptions {
  tokenError: boolean;
  theme: Theme;
  hasToken: boolean;
  hasOAuth: boolean;
  oauthError?: string;
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  not_org_member: "You are not a member of any authorized organization.",
  oauth_denied: "GitHub sign-in was cancelled.",
  oauth_error: "An error occurred during GitHub sign-in. Please try again.",
};

export function buildLoginPage(options: LoginPageOptions): string {
  const { tokenError, theme, hasToken, hasOAuth, oauthError } = options;

  const errorMessage = oauthError
    ? OAUTH_ERROR_MESSAGES[oauthError] ?? OAUTH_ERROR_MESSAGES["oauth_error"]
    : tokenError
      ? "Invalid token. Please try again."
      : "";

  const oauthButton = hasOAuth
    ? `<a href="/auth/github" class="save-btn" style="display:inline-block;text-align:center;text-decoration:none;margin-bottom:1rem;">Sign in with GitHub</a>`
    : "";

  const separator = hasOAuth && hasToken
    ? `<div style="text-align:center;color:var(--text-secondary);margin:1rem 0;font-size:0.85rem;">or</div>`
    : "";

  const tokenForm = hasToken
    ? `<form method="POST" action="/login">
      <label for="token">Auth Token</label>
      <input type="password" name="token" id="token"${!hasOAuth ? " autofocus" : ""}>
      <button type="submit" class="save-btn">Login</button>
    </form>`
    : "";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${siteTitle("login")}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <h1>yeti</h1>
  <div class="login-form">
    <h2>Login</h2>
    ${errorMessage ? `<div class="login-error">${errorMessage}</div>` : ""}
    ${oauthButton}
    ${separator}
    ${tokenForm}
  </div>
</body>
</html>`;
}
