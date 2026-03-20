# Deploy Script Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove deprecated kwyjibo config from deploy scripts, add all current ConfigFile fields, remove Slack notifications from deploy.sh, and add CLAUDE.md guidance.

**Architecture:** Pure file edits — shell scripts, one TypeScript drive-by fix, and markdown. No new files, no new dependencies.

**Tech Stack:** Bash, JSON, Markdown

**Spec:** `.superpowers/specs/2026-03-20-deploy-script-cleanup-design.md`

---

### Task 1: Create feature branch

**Files:** None

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/deploy-cleanup
```

- [ ] **Step 2: Verify clean state**

```bash
git status
```

Expected: clean working tree on `feat/deploy-cleanup`

---

### Task 2: Update install.sh bootstrap config.json template

**Files:**
- Modify: `deploy/install.sh:45-56` (config.json template and log message)

- [ ] **Step 1: Replace the config.json heredoc**

In `deploy/install.sh`, replace only the JSON body inside the heredoc (lines 46-52, between the `cat > "$CONFIG_FILE" << 'CONF'` opener on line 45 and the `CONF` terminator on line 53 — leave both of those lines intact). The current JSON body is:

```json
{
  "slackWebhook": "",
  "githubOwners": ["frostyard", "frostyard"],
  "selfRepo": "frostyard/yeti",
  "kwyjiboBaseUrl": "https://kwyjibo.vercel.app",
  "kwyjiboApiKey": ""
}
```

Replace with:

```json
{
  "githubOwners": ["frostyard"],
  "selfRepo": "frostyard/yeti",
  "port": 9384,
  "slackWebhook": "",
  "slackBotToken": "",
  "slackIdeasChannel": "",
  "discordBotToken": "",
  "discordChannelId": "",
  "discordAllowedUsers": [],
  "whatsappEnabled": false,
  "whatsappAllowedNumbers": [],
  "openaiApiKey": "",
  "authToken": "",
  "maxClaudeWorkers": 2,
  "claudeTimeoutMs": 1200000,
  "intervals": {
    "issueWorkerMs": 300000,
    "issueRefinerMs": 300000,
    "ciFixerMs": 600000,
    "reviewAddresserMs": 300000,
    "autoMergerMs": 600000,
    "triageYetiErrorsMs": 600000
  },
  "schedules": {
    "docMaintainerHour": 1,
    "repoStandardsHour": 2,
    "improvementIdentifierHour": 3,
    "issueAuditorHour": 5
  },
  "logRetentionDays": 14,
  "logRetentionPerJob": 20,
  "pausedJobs": [],
  "skippedItems": [],
  "prioritizedItems": []
}
```

- [ ] **Step 2: Update the log message on line 55**

Change:
```bash
  log "Created $CONFIG_FILE — edit it to set your Slack webhook URL"
```

To:
```bash
  log "Created $CONFIG_FILE — edit it to configure your instance"
```

- [ ] **Step 3: Verify the heredoc is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'))" <<'EOF'
{
  "githubOwners": ["frostyard"],
  "selfRepo": "frostyard/yeti",
  "port": 9384,
  "slackWebhook": "",
  "slackBotToken": "",
  "slackIdeasChannel": "",
  "discordBotToken": "",
  "discordChannelId": "",
  "discordAllowedUsers": [],
  "whatsappEnabled": false,
  "whatsappAllowedNumbers": [],
  "openaiApiKey": "",
  "authToken": "",
  "maxClaudeWorkers": 2,
  "claudeTimeoutMs": 1200000,
  "intervals": {
    "issueWorkerMs": 300000,
    "issueRefinerMs": 300000,
    "ciFixerMs": 600000,
    "reviewAddresserMs": 300000,
    "autoMergerMs": 600000,
    "triageYetiErrorsMs": 600000
  },
  "schedules": {
    "docMaintainerHour": 1,
    "repoStandardsHour": 2,
    "improvementIdentifierHour": 3,
    "issueAuditorHour": 5
  },
  "logRetentionDays": 14,
  "logRetentionPerJob": 20,
  "pausedJobs": [],
  "skippedItems": [],
  "prioritizedItems": []
}
EOF
```

Expected: no output (success). Any output means invalid JSON.

- [ ] **Step 4: Commit**

```bash
git add deploy/install.sh
git commit -m "refactor: update install.sh bootstrap config.json template

Remove deprecated kwyjiboBaseUrl/kwyjiboApiKey, add all current
ConfigFile fields (discord, whatsapp, auth, intervals, schedules, etc).
Fix duplicate githubOwners entry."
```

---

### Task 3: Update install.sh bootstrap env file template

**Files:**
- Modify: `deploy/install.sh:62-68` (env file template)

- [ ] **Step 1: Replace the env heredoc**

In `deploy/install.sh`, replace only the env file body inside the heredoc (lines 63-67, between the `cat > "$ENV_FILE" << 'CONF'` opener on line 62 and the `CONF` terminator on line 68 — leave both of those lines intact). The current body is:

```bash
# Environment variables loaded by the yeti systemd unit.
# Uncomment and set values as needed.
# YETI_SLACK_WEBHOOK=https://hooks.slack.com/services/T.../B.../xxx
# KWYJIBO_BASE_URL=https://kwyjibo.vercel.app
# KWYJIBO_AUTOMATION_API_KEY=
```

Replace with:

```bash
# Environment variables loaded by the yeti systemd unit.
# Uncomment and set values as needed. These override config.json.

# Slack
# YETI_SLACK_WEBHOOK=https://hooks.slack.com/services/T.../B.../xxx
# YETI_SLACK_BOT_TOKEN=xoxb-...

# Discord
# YETI_DISCORD_BOT_TOKEN=

# OpenAI (used for WhatsApp voice transcription)
# OPENAI_API_KEY=

# Dashboard auth
# YETI_AUTH_TOKEN=
```

- [ ] **Step 2: Commit**

```bash
git add deploy/install.sh
git commit -m "refactor: update install.sh bootstrap env template

Remove deprecated KWYJIBO_* vars, add all secret env vars
(slack bot token, discord, openai, auth token)."
```

---

### Task 4: Remove Slack notifications from deploy.sh

**Files:**
- Modify: `deploy/deploy.sh:28-43,154,160,167,182` (Slack-related code)

- [ ] **Step 1: Remove Slack webhook config reading (lines 28-29)**

Remove these two lines:

```bash
CONFIG_SLACK_WEBHOOK=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8')).slackWebhook||'')}catch{console.log('')}" 2>/dev/null || echo "")
SLACK_WEBHOOK="${YETI_SLACK_WEBHOOK:-$CONFIG_SLACK_WEBHOOK}"
```

- [ ] **Step 2: Remove Slack warning and function (lines 35-43)**

Remove these lines:

```bash
[[ -n "$SLACK_WEBHOOK" ]] || log "Warning: No Slack webhook configured (checked YETI_SLACK_WEBHOOK in $ENV_FILE and slackWebhook in $CONFIG_FILE)"
slack() {
  if [[ -z "$SLACK_WEBHOOK" ]]; then log "Warning: SLACK_WEBHOOK is empty, skipping notification"; return 0; fi
  local payload
  payload=$(jq -n --arg t "$1" '{"text":$t}')
  if ! curl -sf -X POST -H 'Content-Type: application/json' --data "$payload" "$SLACK_WEBHOOK" 2>&1; then
    log "Warning: Slack notification failed"
  fi
}
```

- [ ] **Step 3: Remove `RELEASE_BODY` fetch (line 71)**

This line is no longer needed since it was only used for the Slack notification message. Remove:

```bash
RELEASE_BODY=$(sudo -u yeti gh release view "$LATEST_TAG" -R "$REPO" --json body --jq '.body' 2>/dev/null || echo "")
```

- [ ] **Step 4: Remove all four `slack` calls and the `DEPLOY_MSG` block**

Remove each of these four `slack` calls (search for `slack "` to find them):

Line 154:
```bash
      slack "Deploy of yeti $LATEST_TAG failed — rolled back to $CURRENT_TAG"
```

Line 160:
```bash
      slack "Deploy of yeti $LATEST_TAG failed — rollback also failed, manual intervention required"
```

Line 167:
```bash
    slack "Deploy of yeti $LATEST_TAG failed — no previous version to rollback to"
```

Then delete lines 178-182 entirely (the `DEPLOY_MSG` block and final `slack` call). Line 177 already has `log "Update to $LATEST_TAG complete"` which is the correct success output:

```bash
DEPLOY_MSG="Deployed yeti $LATEST_TAG"
if [[ -n "$RELEASE_BODY" ]]; then
  DEPLOY_MSG=$(printf '%s\n\n%s' "$DEPLOY_MSG" "$RELEASE_BODY")
fi
slack "$DEPLOY_MSG"
```

- [ ] **Step 5: Clean up stray blank lines**

After the removals, collapse any consecutive blank lines in deploy.sh down to single blank lines for readability.

- [ ] **Step 6: Verify the script is syntactically valid**

```bash
bash -n deploy/deploy.sh
```

Expected: no output (success). Any output means syntax error.

- [ ] **Step 7: Verify no remaining references to slack or RELEASE_BODY**

```bash
grep -in 'slack\|RELEASE_BODY\|DEPLOY_MSG' deploy/deploy.sh
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add deploy/deploy.sh
git commit -m "refactor: remove Slack notifications from deploy.sh

App handles its own notifications via notify.ts on startup.
Removes jq dependency from deploy script."
```

---

### Task 5: Fix duplicate githubOwners in config.ts

**Files:**
- Modify: `src/config.ts:100`

- [ ] **Step 1: Run existing tests to establish baseline**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Fix the duplicate default**

In `src/config.ts` line 100, change:

```typescript
    : file.githubOwners ?? ["frostyard", "frostyard"];
```

To:

```typescript
    : file.githubOwners ?? ["frostyard"];
```

- [ ] **Step 3: Run tests again**

```bash
npm test
```

Expected: all tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "fix: remove duplicate githubOwners default in config.ts"
```

---

### Task 6: Add deployment scripts section to CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (after the "Deployment" section, line 71)

- [ ] **Step 1: Add the new section**

After line 71 (the end of the "Deployment" section), add:

```markdown

## Deployment Scripts

After any change to `src/config.ts` (new config fields, removed fields, env var changes), update the bootstrap templates in `deploy/install.sh` to match. Also review `deploy/deploy.sh` if the deployment lifecycle changes.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add deployment scripts maintenance guidance to CLAUDE.md"
```

---

### Task 7: Final verification

**Files:** None (read-only checks)

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Verify build succeeds**

```bash
npm run build
```

Expected: clean compilation, no errors.

- [ ] **Step 3: Verify no remaining kwyjibo references in deploy/**

```bash
grep -ri 'kwyjibo' deploy/
```

Expected: no output.

- [ ] **Step 4: Verify install.sh config.json template fields match ConfigFile interface**

```bash
node -e "
const fs = require('fs');
const config = fs.readFileSync('src/config.ts', 'utf-8');
const iface = config.match(/export interface ConfigFile \{([\s\S]*?)\n\}/)[1];
const fields = [...iface.matchAll(/^\s+(\w+)\??:/gm)].map(m => m[1]).sort();
console.log('ConfigFile fields:', fields.join(', '));
"
```

Cross-check this output against the keys in the install.sh config.json template. They should match exactly.

- [ ] **Step 5: Review git log for the branch**

```bash
git log --oneline main..HEAD
```

Expected: 5 commits (config template, env template, deploy.sh cleanup, config.ts fix, CLAUDE.md).
