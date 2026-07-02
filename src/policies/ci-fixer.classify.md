You are classifying a CI failure to determine whether it was caused by the changes in this pull request.

PR #${PR_NUMBER}: ${PR_TITLE}
Branch: ${HEAD_REF}

Files changed in this PR:
${CHANGED_FILES}

CI failure log:
```
${FAIL_LOG}
```

Classify this failure. Respond with ONLY a JSON object (no markdown, no explanation):
{
  "related": true/false,
  "fingerprint": "short-stable-id",
  "reason": "1-2 sentence explanation"
}

Classification rules:
- "related": true if the failure is caused by or related to the PR's changes
  - Failures in files the PR modified → related
  - Test failures testing code the PR changed → related
  - Build errors from the PR's changes → related
- "related": false if the failure is NOT caused by the PR
  - Flakey tests (timeouts, race conditions, intermittent failures) → unrelated
  - CI runner issues (disk space, network, docker pull limits) → unrelated
  - Pre-existing failures that exist on the base branch → unrelated
- When in doubt, classify as related (safe default)

- "fingerprint": a short, stable, human-readable identifier for this class of failure
  Examples: "flakey-test:auth-timeout", "runner:disk-space", "preexisting:lint-config"
  Use category:detail format. Be consistent — the same issue should get the same fingerprint.

- "reason": brief explanation of why you classified it this way
