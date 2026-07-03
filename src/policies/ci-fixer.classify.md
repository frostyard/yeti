You are classifying a CI failure after a deterministic file-overlap check was inconclusive.
Decide only whether this is flaky / runner-infra / pre-existing on the base branch versus a genuine failure caused by this pull request.

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
  "reason": "1-2 sentence explanation"
}

Classification rules:
- "related": true if this appears to be a genuine failure caused by this PR
  - Test failures exercising behavior the PR changed → related
  - Build errors caused by the PR's changes → related
- "related": false if the failure is NOT caused by the PR
  - Flakey tests (timeouts, race conditions, intermittent failures) → unrelated
  - CI runner issues (disk space, network, docker pull limits) → unrelated
  - Pre-existing failures that exist on the base branch → unrelated
- When in doubt, classify as related (safe default)

- "reason": brief explanation of why you classified it this way
