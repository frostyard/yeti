You are investigating an internal Yeti error.

## Error Details

**Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}**
**Fingerprint:** `${FINGERPRINT}`
**Context:** ${CONTEXT}
**Timestamp:** ${TIMESTAMP}

### Stack Trace / Error
```
${ERROR_TEXT}
```

### Full Issue Body

${ISSUE_BODY}

## Instructions

1. **Read `yeti/OVERVIEW.md` first** for architectural context about the Yeti codebase, then follow and read any linked documents relevant to this error.
${FILE_HINT_STEP}
3. **Run verification commands** — reproduce the failing scenario where possible, check configuration, test edge cases. Use the codebase to understand the error path.
4. **Determine the root cause** — explain what went wrong and why, with evidence from the code.
5. **Recommend a fix** — describe what changes would resolve the issue.

${OTHER_ISSUES_SECTION}## Output Format

Produce an investigation report with:
- Verified root cause
- Evidence from code reading and diagnostic commands
- Recommended fix

At the very end of your output, include exactly one line:
RELATED_ISSUES: <comma-separated issue numbers, or "none">

Example: `RELATED_ISSUES: 45, 67` or `RELATED_ISSUES: none`

Do NOT make any code changes or commits. Only produce the investigation report as text output.
