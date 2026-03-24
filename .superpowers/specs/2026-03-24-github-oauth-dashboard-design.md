# GitHub OAuth Authentication for Dashboard

## Problem

The Yeti dashboard uses a static `authToken` string for authentication. Anyone with the token has full access, and there's no way to know *who* is logged in. With the GitHub App now in place, we can leverage its built-in OAuth flow to let org members sign in with their GitHub identity.

## Requirements

- **Org-scoped access**: Only members of configured GitHub organizations can log in via OAuth
- **Backward compatible**: Existing `authToken` continues to work for API/headless access
- **Optional**: If OAuth client ID/secret aren't configured, everything works exactly as today
- **Zero new dependencies**: Use Node.js built-in `crypto` and `fetch()`
- **Stateless sessions**: Signed cookie, no server-side session store
- **Behind reverse proxy**: Dashboard served over HTTP, TLS handled by nginx/caddy

## When Is Auth Enabled?

Dashboard auth is enabled when **either** `authToken` is non-empty **or** OAuth is configured. This replaces the current check which only looks at `authToken`.

| `authToken` | OAuth configured | Result |
| --- | --- | --- |
| empty | no | Auth disabled — all routes public (current behavior) |
| set | no | Token-only auth (current behavior) |
| empty | yes | OAuth-only — must sign in with GitHub |
| set | yes | Both methods accepted |

The `requireAuth()` guard and `/login` page behavior both derive from this table.

### `/login` page behavior

| State | What the login page shows |
| --- | --- |
| Neither configured | Redirect to `/` (auth disabled) |
| Token only | Token form only (current behavior) |
| OAuth only | "Sign in with GitHub" button only |
| Both | "Sign in with GitHub" button, separator, token form below |

Error messages shown for query params: `?error=not_org_member`, `?error=oauth_denied`, `?error=oauth_error`.

## Config Changes (`src/config.ts`)

New immutable fields (require restart), exported as `const` like `DISCORD_BOT_TOKEN`:

| Field | Env Var | Default | Description |
| --- | --- | --- | --- |
| `githubAppClientId` | `YETI_GITHUB_APP_CLIENT_ID` | `""` | OAuth client ID from the GitHub App |
| `githubAppClientSecret` | `YETI_GITHUB_APP_CLIENT_SECRET` | `""` | OAuth client secret |
| `externalUrl` | `YETI_EXTERNAL_URL` | `""` | Public URL for callback (e.g., `https://yeti.example.com`) |

Add to `ConfigFile` interface. Add `githubAppClientSecret` to `SENSITIVE_KEYS`. Export as immutable `const` (not `let`) — consistent with `DISCORD_BOT_TOKEN`.

**OAuth is active** when `githubAppClientId`, `githubAppClientSecret`, and `externalUrl` are all non-empty.

**`externalUrl` validation at startup**: Strip trailing slashes. Reject (log warning, disable OAuth) if the value is empty, does not start with `http://` or `https://`, or is otherwise malformed. If client ID and secret are set but `externalUrl` fails validation, log a warning and disable OAuth — do not refuse to start.

## Org Membership Constraint

The `githubOwners` config contains "organizations or usernames." The `/orgs/{org}/members/{username}` endpoint only works for organizations — it will 404 for personal usernames.

**Decision**: OAuth org membership checks only run against entries in `githubOwners` that are actual GitHub organizations. The `exchangeCodeForUser()` function calls `GET /orgs/{owner}/members/{username}` for each owner. A 404 could mean "not a member" or "not an org" — both result in skipping that owner. The user is authorized if the check succeeds (204) for **any** configured owner (OR logic).

This means: if `githubOwners` contains only personal usernames and no orgs, the org check will fail for all entries and OAuth login will be denied. This is the correct behavior — OAuth requires at least one org in `githubOwners` to work. Document this clearly in the setup guide.

## New Module: `src/oauth.ts`

Handles the OAuth flow, session signing/verification, and org membership checks. Keeps `server.ts` focused on routing.

### Exports

```typescript
export function isOAuthConfigured(): boolean;
export function getAuthorizationUrl(state: string): string;
export async function exchangeCodeForUser(code: string): Promise<{ login: string } | null>;
export function createSessionCookie(login: string): string;
export function verifySessionCookie(cookie: string): { login: string } | null;
```

**Responsibility boundary**: `server.ts` handles cookies (state CSRF check, setting/clearing session cookie). `oauth.ts` handles GitHub API calls (code exchange, identity, org membership). `exchangeCodeForUser()` takes the code and returns a login or null — it does not touch cookies.

### Session Signing Key

Use a **derived key** rather than the raw `githubAppClientSecret`:

```typescript
const sessionKey = crypto.createHmac("sha256", githubAppClientSecret)
  .update("yeti-session-key")
  .digest();
```

This decouples session integrity from the OAuth credential: rotating the client secret still invalidates sessions (the derived key changes), but the raw secret is never used directly as a signing key. If `authToken` is configured, it's mixed in as additional entropy, but this is optional.

### OAuth Flow

**Step 1 — Initiate** (`GET /auth/github`):

Generate a random `state` string, store it in a short-lived `yeti_oauth_state` cookie:

- `Max-Age=300` (5 minutes)
- `HttpOnly`, `SameSite=Lax` (must be Lax for the cross-site redirect from GitHub to work)
- `Secure` when `externalUrl` starts with `https://`
- `Path=/auth/callback` (only sent on the callback, not on every request)

Redirect to:

```
https://github.com/login/oauth/authorize?client_id={id}&redirect_uri={externalUrl}/auth/callback&state={state}&scope=read:org
```

The `read:org` scope is required for the org membership check to work with private org memberships.

**Step 2 — Callback** (`GET /auth/callback?code={code}&state={state}`):

1. Verify `state` matches the `yeti_oauth_state` cookie. Reject with redirect to `/login?error=oauth_error` if mismatch or missing.
2. Exchange `code` for user access token via `fetch()`:

   ```
   POST https://github.com/login/oauth/access_token
   Body: { client_id, client_secret, code }
   Accept: application/json
   ```

3. Fetch user identity: `GET https://api.github.com/user` with Bearer token.
4. Check org membership: `GET https://api.github.com/orgs/{org}/members/{username}` for each `githubOwners` entry. 204 = member (authorized). OR logic — any org match is sufficient.
5. The user access token is used only during this handler and is **not persisted**.
6. Clear the `yeti_oauth_state` cookie (set `Max-Age=0` with matching `Path`, `HttpOnly`, `SameSite`, `Secure` attributes).
7. If authorized: set `yeti_session` cookie and redirect to `/`.
8. If not a member of any configured org: redirect to `/login?error=not_org_member`.

**Error mapping for callback failures:**

| Failure | Action |
| --- | --- |
| User denied consent (`?error=access_denied`) | Redirect to `/login?error=oauth_denied` |
| Missing `code` param | Redirect to `/login?error=oauth_error` |
| State mismatch / missing | Redirect to `/login?error=oauth_error` |
| Token exchange fails (GitHub 5xx, network error) | Redirect to `/login?error=oauth_error`, log the error |
| Identity fetch fails | Redirect to `/login?error=oauth_error`, log the error |
| Org check fails for all owners | Redirect to `/login?error=not_org_member` |

No errors are exposed to the user beyond the generic category. Details are logged server-side.

**Step 3 — Logout** (`GET /auth/logout`):

Clear `yeti_session` cookie by setting it with `Max-Age=0` and matching attributes (`HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/`). Redirect to `/login`.

### Session Cookie

The `yeti_session` cookie contains an HMAC-signed JSON payload:

```
base64url(payload).base64url(hmac-sha256(payload, derivedKey))
```

Payload: `{ "login": "username", "exp": <unix_timestamp> }`

- Signed with the derived session key (see "Session Signing Key" above)
- `exp` set to 24 hours from login
- `HttpOnly`, `SameSite=Strict`, `Path=/`
- `Secure` when `externalUrl` starts with `https://`

Verification: parse payload, recompute HMAC with derived key, timing-safe compare, check `exp`.

**Note**: Changing `githubAppClientSecret` invalidates all existing sessions (users must re-authenticate). This is expected behavior.

## Changes to `src/server.ts`

### Auth Middleware

Redefine the "auth enabled" check: auth is enabled when `AUTH_TOKEN` is non-empty **or** `isOAuthConfigured()` returns true. This replaces the current `!config.AUTH_TOKEN` early-return.

Update `requireAuth()` to check in order:

1. `Authorization: Bearer <token>` header → compare against `AUTH_TOKEN` (if `AUTH_TOKEN` is set)
2. `yeti_token` cookie → compare against `AUTH_TOKEN` (if `AUTH_TOKEN` is set)
3. `yeti_session` cookie → verify HMAC signature and expiry via `verifySessionCookie()` (if OAuth is configured)

If any passes, the request is authorized. The request also carries the username (from step 3, or null for token auth). If all fail, 302 redirect to `/login`.

### Username Threading

Extract the logged-in username from the session cookie once per request in the route handler. Pass it to page builders as an optional parameter. This is a `string | null` — null when authenticated via static token or when auth is disabled.

### New Routes

| Route | Method | Description |
| --- | --- | --- |
| `/auth/github` | GET | Redirect to GitHub OAuth authorize URL |
| `/auth/callback` | GET | Handle OAuth callback, exchange code, set session |
| `/auth/logout` | GET | Clear session cookie, redirect to login |

All three are public (no auth required). `/health` and `/login` remain public. `/status` remains protected (matches current behavior in `server.ts`).

**When OAuth is not configured**: `/auth/github`, `/auth/callback`, and `/auth/logout` return 302 redirect to `/login`. They do not 404 or 500.

## Changes to Other Files

### `src/pages/login.ts`

Add "Sign in with GitHub" button and conditional rendering based on which auth methods are configured (see login page behavior table above). Add error message display for OAuth failures (`not_org_member`, `oauth_denied`, `oauth_error`).

### `src/pages/layout.ts`

Update `buildNav()` to accept an optional `username: string | null` parameter. When non-null, show `Logged in as {username} · Logout` in the nav.

**Note**: The login page (`src/pages/login.ts`) does NOT call `buildNav()` — it has its own minimal layout. So the `buildNav` change only affects the authenticated pages: dashboard, config, queue, logs, jobs, repos.

### `src/pages/*.ts` (dashboard, config, queue, logs, jobs, repos)

Each page builder function gains an optional `username` parameter and passes it to `buildNav()`. The corresponding route handlers in `server.ts` pass the extracted username.

### `src/pages/config.ts`

Add "OAuth" section showing `githubAppClientId`, `externalUrl` as read-only display values (same pattern as GitHub App fields). `githubAppClientSecret` shown masked via `SENSITIVE_KEYS`.

### `deploy/install.sh`

Add new fields to bootstrap config template:

```json
"githubAppClientId": "",
"githubAppClientSecret": "",
"externalUrl": ""
```

Add to env file template:

```bash
# OAuth (optional — enables GitHub sign-in for the dashboard)
# YETI_GITHUB_APP_CLIENT_ID=
# YETI_GITHUB_APP_CLIENT_SECRET=
# YETI_EXTERNAL_URL=
```

### Documentation

- **`site/getting-started/github-app.md`**: Add "OAuth for Dashboard" section with setup steps, note that OAuth requires at least one org (not personal username) in `githubOwners`
- **`site/reference/configuration.md`**: Add the three new config fields to the reference table
- **`site/reference/api.md`**: Document the three new `/auth/*` routes
- **`site/usage/troubleshooting.md`**: Add OAuth troubleshooting (callback URL mismatch, missing client secret, "not an org member" errors)
- **`CLAUDE.md`** and **`yeti/OVERVIEW.md`**: Add `oauth.ts` module description

## GitHub App Setup (Manual Additions)

In the existing GitHub App settings page:

1. **Callback URL**: Add `{externalUrl}/auth/callback`
2. **Generate client secret**: Copy and save to config
3. Optional: Check "Request user authorization (OAuth) during installation"

No new App permissions needed. The `read:org` scope is requested during the authorization redirect. The user access token is used only during the callback and is not persisted.

## Testing Strategy

### New: `src/oauth.test.ts`

- `isOAuthConfigured()` with various config states (all set, partial, missing externalUrl)
- `getAuthorizationUrl()` produces correct URL with `read:org` scope
- `exchangeCodeForUser()`:
  - Exchanges code for token (mock `fetch`)
  - Fetches user identity
  - Checks org membership — returns login on success, null on non-member
  - Handles GitHub API 5xx/network errors gracefully (returns null)
  - Handles token exchange failure (returns null)
  - Handles non-org owner entries (404 is treated as "not a member," not as error)
- `createSessionCookie()` produces valid signed cookie
- `verifySessionCookie()`:
  - Valid cookie returns login
  - Tampered payload returns null (HMAC mismatch)
  - Expired cookie returns null
  - Malformed cookie returns null

### Updates to `src/server.test.ts`

- Add `oauth.js` mock (with `isOAuthConfigured`, `verifySessionCookie`, etc.)
- Add new config exports to existing config mock
- Test auth-enabled logic: token-only, OAuth-only, both, neither
- Test `/auth/github` redirects correctly
- Test `/auth/callback` sets session cookie on success, rejects invalid state
- Test `/auth/logout` clears cookie with correct attributes
- Test `requireAuth` accepts: valid bearer token, valid token cookie, valid session cookie
- Test `requireAuth` rejects unauthenticated and redirects to `/login`
- Test login page renders correctly for each config combination
- Test OAuth routes are public (no auth required)

## Verification

1. `npm run typecheck` — no errors
2. `npm test` — all tests pass
3. Manual: configure OAuth client ID/secret/external URL, restart
4. Manual: click "Sign in with GitHub", complete OAuth flow, verify session
5. Manual: verify org membership check blocks non-members
6. Manual: verify static `authToken` still works alongside OAuth
7. Manual: verify OAuth-only mode (empty `authToken`, OAuth configured)
8. Manual: verify logout clears session
9. Manual: verify callback error handling (deny consent, tamper with state)
