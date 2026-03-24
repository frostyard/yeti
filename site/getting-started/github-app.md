# GitHub App Setup

!!! note "Optional"
    The GitHub App is **optional**. Yeti works fine with your personal `gh` CLI credentials. You only need a GitHub App if you want to use branch protection rules that require PR reviews --- without the App, Yeti's PRs appear as yours, so you can't approve them yourself.

A GitHub App gives Yeti a separate bot identity (e.g., `yeti[bot]`). PRs created by the App can be approved and merged by you, even with "Require approvals" enabled in branch protection.

## Prerequisites

- **Organization admin access** to your GitHub org (needed to create and install the App)
- **Yeti already installed** --- follow the [Installation](installation.md) guide first

## Create the App

1. Go to **Settings > Developer settings > GitHub Apps** in your GitHub organization:
   ```
   https://github.com/organizations/YOUR_ORG/settings/apps
   ```

2. Click **New GitHub App** and fill in:

   | Field | Value |
   |---|---|
   | **App name** | `yeti` (or any name you prefer) |
   | **Homepage URL** | Your Yeti dashboard URL, e.g., `http://your-host:9384` |
   | **Webhook** | **Uncheck** "Active" --- Yeti polls, it doesn't use webhooks |

3. Under **Permissions > Repository permissions**, set:

   | Permission | Access |
   |---|---|
   | **Contents** | Read & write |
   | **Issues** | Read & write |
   | **Pull requests** | Read & write |
   | **Checks** | Read-only |
   | **Metadata** | Read-only (required, auto-selected) |

   If you plan to use [OAuth for the dashboard](#oauth-for-dashboard-optional), also set under **Organization permissions**:

   | Permission | Access |
   |---|---|
   | **Members** | Read-only |

4. Under **Where can this app be installed?**, select **Only on this account**.

5. Click **Create GitHub App**.

## Install the App

After creating the App, you'll be on its settings page.

1. In the left sidebar, click **Install App**.
2. Click **Install** next to your organization.
3. Choose **All repositories** or select specific repos. Yeti only operates on repos in its `allowedRepos` or `githubOwners` config, so "All repositories" is usually fine.
4. Click **Install**.

## Generate a private key

1. Go back to the App's settings page (**Settings > Developer settings > GitHub Apps > your app**).
2. Scroll to **Private keys** and click **Generate a private key**.
3. A `.pem` file will download. Copy it to the Yeti host:
   ```bash
   scp ~/Downloads/your-app.2026-03-24.private-key.pem your-host:~/.yeti/github-app.pem
   ```
4. Set permissions:
   ```bash
   chmod 600 ~/.yeti/github-app.pem
   ```

## Find your IDs

You need two IDs from the App:

**App ID** --- On the App's settings page, near the top. It's a numeric value like `123456`.

**Installation ID** --- Go to your org's **Settings > Integrations > GitHub Apps**, click **Configure** next to the App. The Installation ID is the number at the end of the URL:
```
https://github.com/organizations/YOUR_ORG/settings/installations/78901234
                                                                 ^^^^^^^^
                                                          Installation ID
```

## Configure Yeti

Add the three fields to `~/.yeti/config.json`:

```json
{
  "githubAppId": "123456",
  "githubAppInstallationId": "78901234",
  "githubAppPrivateKeyPath": "/home/yeti/.yeti/github-app.pem"
}
```

Or set them as environment variables in `~/.yeti/env`:

```bash
YETI_GITHUB_APP_ID=123456
YETI_GITHUB_APP_INSTALLATION_ID=78901234
YETI_GITHUB_APP_PRIVATE_KEY_PATH=/home/yeti/.yeti/github-app.pem
```

!!! warning
    These settings require a restart to take effect. Changing them via the dashboard will not apply until Yeti is restarted.

## Restart and verify

```bash
sudo systemctl restart yeti
journalctl -u yeti -f
```

You should see:

```
GitHub App authentication enabled
[github-app] github.com: Logged in as ...
[github-app] Token expires at 2026-03-24T13:00:00.000Z
```

The dashboard's **Integrations** section will show `GitHub Auth: App (yeti[bot])` instead of `Personal (gh CLI)`.

## Test the workflow

1. Create or label an issue to trigger a Yeti job that creates a PR.
2. The PR should appear as authored by `yeti[bot]` (or whatever you named the App).
3. As your personal GitHub account, review and approve the PR.
4. Post an `LGTM` comment (or just approve --- the auto-merger accepts either).
5. The auto-merger should merge the PR.

## OAuth for Dashboard (Optional)

If you want GitHub sign-in for the Yeti dashboard (instead of or alongside the static `authToken`), you can enable OAuth using your existing GitHub App. This is entirely optional --- token-based auth continues to work.

### 1. Add a callback URL

In your GitHub App settings page (**Settings > Developer settings > GitHub Apps > your app**):

1. Under **Callback URL**, add your Yeti external URL with the `/auth/callback` path, e.g., `https://yeti.example.com/auth/callback`.

### 2. Add organization member read permission

OAuth login verifies that the user is a member of your org. This requires the App to have the **Members** permission:

1. In your App settings, go to **Permissions > Organization permissions**.
2. Set **Members** to **Read-only** and save.
3. Go to your org's **Settings > Integrations > GitHub Apps**, click **Configure** next to the App.
4. GitHub will show a banner asking you to **review and accept** the updated permissions. **You must accept** --- the permission won't take effect until you do.

!!! warning "Permission changes require acceptance"
    Whenever you update a GitHub App's permissions, the installation owner must explicitly accept the change. GitHub sends an email notification and shows a banner on the installation page. Until accepted, API calls that need the new permission will silently fail with 404 errors.

### 3. Generate a client secret

On the same App settings page, scroll to **Client secrets** and click **Generate a new client secret**. Copy the value immediately --- it won't be shown again.

### 4. Configure Yeti

Add the three OAuth fields to `~/.yeti/config.json`:

```json
{
  "githubAppClientId": "Iv1.abc123...",
  "githubAppClientSecret": "your-client-secret",
  "externalUrl": "https://yeti.example.com"
}
```

Or as environment variables in `~/.yeti/env`:

```bash
YETI_GITHUB_APP_CLIENT_ID=Iv1.abc123...
YETI_GITHUB_APP_CLIENT_SECRET=your-client-secret
YETI_EXTERNAL_URL=https://yeti.example.com
```

The **Client ID** is shown on your GitHub App's settings page (different from the App ID).

!!! warning "Org membership required"
    OAuth login checks that the user is a member of at least one organization listed in `githubOwners`. If `githubOwners` contains only personal usernames (not orgs), OAuth login will be denied for all users. You need at least one actual GitHub organization in `githubOwners`.

### 5. Restart Yeti

```bash
sudo systemctl restart yeti
```

The login page will now show a "Sign in with GitHub" button. If `authToken` is also set, both methods are available.

---

## Troubleshooting

**"GitHub App private key not found"** --- The path in `githubAppPrivateKeyPath` doesn't exist or isn't readable. Check the path and file permissions.

**"permissions 644, expected 600"** --- The PEM file is world-readable. Run `chmod 600 ~/.yeti/github-app.pem`.

**Token refresh errors in logs** --- The App ID or Installation ID may be wrong. Double-check both values against the GitHub App settings page.

**"base branch policy prohibits the merge"** --- Branch protection may require the App itself to be listed as a bypass actor, or there may be additional rules (like required status checks) that aren't passing. Check your branch protection settings.

**PRs still showing your personal username** --- The App config requires a restart. Run `sudo systemctl restart yeti` after changing the config.

**OAuth: "not an org member" error** --- Three things to check: (1) The App must have **Organization > Members: Read** permission, and the permission change must be **accepted** on the installation page (check for a banner at your org's GitHub Apps settings). (2) At least one entry in `githubOwners` must be an actual GitHub organization, not a personal username. (3) The user must actually be a member of that org.

**OAuth: callback URL mismatch** --- The callback URL in your GitHub App settings must exactly match `{externalUrl}/auth/callback`. Check for trailing slashes, `http` vs `https`, and port mismatches.

**OAuth: login page shows no "Sign in with GitHub" button** --- All three fields must be set: `githubAppClientId`, `githubAppClientSecret`, and `externalUrl`. Check your config and restart Yeti.

---

[Next: Configuration :material-arrow-right:](configuration.md){ .md-button .md-button--primary }
