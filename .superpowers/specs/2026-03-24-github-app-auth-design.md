# GitHub App Authentication for Yeti

## Problem

Yeti authenticates via the human user's `gh` CLI credentials (personal GitHub account). When branch protection requires PR reviews, the human cannot approve PRs that Yeti created because GitHub considers them the same identity. Adding GitHub App authentication gives Yeti a separate bot identity, enabling the human to approve Yeti's PRs normally.

## Approach: GitHub App with Installation Tokens

Create a GitHub App owned by the frostyard org. Yeti authenticates as the App using short-lived installation tokens injected via `process.env.GH_TOKEN`. All existing `gh` and `git` subprocess calls inherit this automatically — zero changes to individual call sites.

## New Module: `src/github-app.ts`

Handles JWT generation (RS256 via Node.js built-in `crypto`), installation token lifecycle, and initialization.

### Exports

```typescript
export function isGitHubAppConfigured(): boolean;
export async function initGitHubApp(): Promise<void>;
export async function ensureGitHubAppToken(): Promise<void>;
export function getAppSlug(): string | null;
```

### JWT Generation

- Read PEM private key from the file path specified in config
- Use `crypto.createSign('RSA-SHA256')` to sign a JWT with claims: `iss` (app ID), `iat` (now - 30s for clock drift), `exp` (now + 10 min)
- Base64url-encode header and payload, sign, return token
- No new npm dependency needed

### Token Lifecycle

- **Init** (`initGitHubApp()`):
  1. Validate config: App ID, Installation ID, PEM file exists and is readable
  2. Warn if PEM file permissions are not 0600
  3. Sign JWT, temporarily set `process.env.GH_TOKEN` to the JWT (note: init runs before the scheduler starts, so no concurrent `gh` calls use this temporary value)
  4. Exchange for installation token via `gh api POST /app/installations/{id}/access_tokens`
  5. Set `process.env.GH_TOKEN` to the installation token
  6. Run `gh auth setup-git` to configure git credential helper
  7. Run `gh auth status` and log the active identity for verification
  8. Clear `_selfLogin` cache in `github.ts` (so subsequent calls return the App's login)
  9. Log the token expiry timestamp for debugging
- **Refresh** (`ensureGitHubAppToken()`): Check if token expires within 5 minutes. If so, regenerate JWT and exchange for a new installation token. Uses in-flight promise dedup (same pattern as `inflightClones` in `claude.ts`) to handle concurrent callers.
- **Fallback**: If no App config, all functions are no-ops. Existing `gh` CLI auth works as before.

### Token Validity

Installation tokens last 1 hour. With the 5-minute pre-expiry buffer, jobs always start with 55+ minutes of validity — well beyond the 20-minute AI process timeout.

## Config Changes (`src/config.ts`)

New fields in `ConfigFile`:

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `githubAppId` | `YETI_GITHUB_APP_ID` | `""` | GitHub App ID |
| `githubAppInstallationId` | `YETI_GITHUB_APP_INSTALLATION_ID` | `""` | Installation ID |
| `githubAppPrivateKeyPath` | `YETI_GITHUB_APP_PRIVATE_KEY_PATH` | `""` | Absolute path to PEM file |

Private key stored as a file path reference, never as config content. The path itself is NOT added to `SENSITIVE_KEYS` (it's not secret; masking it makes debugging harder).

App config fields require restart — they are NOT live-reloadable. Changing App credentials mid-flight risks invalidating the current token and breaking all in-progress API calls. This is consistent with other immutable config like `SERVER_PORT` and Discord bot token.

## Changes to Existing Modules

### `src/github.ts`

- Add `clearSelfLogin()` export to reset the `_selfLogin` cache (called by `initGitHubApp()`)
- **No changes to `gh()` function** — `GH_TOKEN` in `process.env` is automatically inherited by `execFile`

### `src/images.ts`

- Update `getGitHubToken()` (line 92) to check `process.env.GH_TOKEN` first, falling back to `gh auth token`. Currently it always calls `gh auth token` which reads from gh's internal credential store (the personal token), creating a split-identity problem.

### `src/claude.ts`

- **No changes needed** — `git()`, `ensureClone()`, and `pushBranch()` all inherit `process.env`
- `ensureClone()` (line 258) calls `gh repo clone` which also inherits `GH_TOKEN`
- `gh auth setup-git` configures git's credential helper to use `gh`, which reads `GH_TOKEN`

### `src/main.ts`

- After DB init, before job registration: call `initGitHubApp()` if configured (with try/catch fallback to personal auth)
- Before each job's `run()` in the job definition array (lines 103-180): call `ensureGitHubAppToken()` as the first line of each job's run function

### `src/jobs/auto-merger.ts`

- For Yeti PRs: update to check `getPRReviewDecision()` in addition to the existing LGTM comment check. When branch protection requires reviews, a proper GitHub review approval is needed. With App auth, the human can provide this via GitHub UI. The LGTM comment remains as an additional signal for the merge intent.
- No auto-approve feature — GitHub Apps cannot approve PRs they authored (returns 422). The human's GitHub UI approval satisfies branch protection.

### `src/pages/config.ts`

Add "GitHub App" section with fields for App ID, Installation ID, and Private Key Path. Include a note that changes require restart.

### `src/pages/dashboard.ts`

Add auth status indicator: `GitHub Auth: App (yeti-app[bot])` or `GitHub Auth: Personal (username)`.

### `deploy/install.sh`

Add new fields to bootstrap config template with empty defaults. Add commented env vars to `~/.yeti/env`.

## GitHub App Permissions

The App needs these repository permissions:

- **Contents** (R/W) — clone repos, push branches
- **Issues** (R/W) — read/create/comment/label issues
- **Pull Requests** (R/W) — create/update/merge PRs, read reviews
- **Checks** (Read) — read check suite status for auto-merger
- **Metadata** (Read) — required by GitHub for all Apps

## Implementation Sequence

1. `src/config.ts` + config tests — Add new config fields
2. `src/github-app.ts` + `src/github-app.test.ts` — New module with JWT, token management, tests
3. `src/github.ts` — Add `clearSelfLogin()` export
4. `src/images.ts` — Fix `getGitHubToken()` to prefer `process.env.GH_TOKEN`
5. `src/main.ts` — Init at startup, token refresh before job ticks
6. `src/jobs/auto-merger.ts` — Add review decision check alongside LGTM
7. `src/pages/config.ts` — Dashboard config editor section
8. `src/pages/dashboard.ts` — Auth status indicator
9. `deploy/install.sh` — Bootstrap config and env file updates
10. Documentation — CLAUDE.md, yeti/OVERVIEW.md, README.md

## GitHub App Setup (Manual, One-Time)

1. Go to `github.com/organizations/frostyard/settings/apps` → New GitHub App
2. App name: `yeti` (or similar)
3. Permissions: Contents (R/W), Issues (R/W), Pull Requests (R/W), Checks (Read), Metadata (Read)
4. Subscribe to events: none required (Yeti polls, doesn't use webhooks)
5. Install on frostyard org (all repos or selected)
6. Generate private key → save to `~/.yeti/github-app.pem` with `chmod 600`
7. Note the App ID (shown on App settings page) and Installation ID (from the installations URL)
8. Add to `~/.yeti/config.json`:
   ```json
   {
     "githubAppId": "123456",
     "githubAppInstallationId": "78901234",
     "githubAppPrivateKeyPath": "/home/yeti/.yeti/github-app.pem"
   }
   ```
9. Restart Yeti — logs should show `GitHub App authentication enabled` and the bot identity

## Workflow Change

**Before (personal auth):**

1. Yeti creates PR as `bjk`
2. `bjk` cannot approve own PR → branch protection blocks merge
3. Auto-merger skips PR (current workaround from `ee1141c`)

**After (App auth):**

1. Yeti creates PR as `yeti-app[bot]`
2. `bjk` approves PR via GitHub UI (different identity — works!)
3. `bjk` posts LGTM comment (existing workflow)
4. Auto-merger detects approval + LGTM + checks passing → merges

## Testing Strategy

### New: `src/github-app.test.ts`

- JWT generation (structure, claims, base64url encoding, signature)
- Token caching (mock API call, verify cache hit on second call)
- Token refresh (advance time past expiry, verify refresh)
- `isGitHubAppConfigured()` with various config states (all set, partial, none)
- Graceful handling of missing/invalid PEM file
- `initGitHubApp()` sets `process.env.GH_TOKEN`
- Concurrent `ensureGitHubAppToken()` calls deduped (only one API call)
- PEM permission warning

### Existing test impact

- Tests already mock `execFile` at module level — unaffected by `GH_TOKEN`
- Add `afterEach(() => { delete process.env.GH_TOKEN; })` cleanup where needed
- Add config field tests bundled with step 1

## Verification

1. `npm run typecheck` — no type errors
2. `npm test` — all existing + new tests pass
3. Manual: create GitHub App, configure Yeti, restart
4. Check logs: `GitHub App authentication enabled`, bot identity logged
5. Trigger a job that creates a PR — verify it shows as `yeti-app[bot]`
6. Approve the PR as your personal account — verify branch protection is satisfied
7. Post LGTM — verify auto-merger merges the PR

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| JWT signing | Node.js `crypto` built-in | No new dependency; GitHub App JWT is simple RS256 |
| Token injection | `process.env.GH_TOKEN` | All subprocess calls inherit implicitly; zero call-site changes |
| Token refresh | Lazy with 5-min buffer | Simple, no background timer, cheap timestamp check |
| Git push auth | `gh auth setup-git` once | Configures credential helper to use `gh` which reads `GH_TOKEN` |
| Config storage | Path to PEM file | Private key stays on disk, never in config.json |
| Fallback | Graceful degradation | No App config = works exactly as before |
| App config | Immutable (requires restart) | Prevents mid-flight token invalidation from bad config edits |
| Auto-approve | Not implemented | GitHub Apps cannot approve their own PRs (422 error). Human approves via UI instead. |
