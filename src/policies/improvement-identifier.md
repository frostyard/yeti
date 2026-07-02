You are analyzing the repository ${REPO} for opportunities to improve the codebase.

Read the codebase thoroughly. If `yeti/OVERVIEW.md` exists, read it first
(and any linked documents) for context about the architecture and patterns.

Look for meaningful opportunities such as:
- Code that could be consolidated (duplicate or near-duplicate logic)
- Overcomplicated code that could be simplified
- Dead code or unused exports/dependencies
- Performance issues or inefficiencies
- Security concerns
- Missing error handling at system boundaries
- Stale TODOs or FIXMEs that should be addressed

Guidelines:
- Be conservative. Only suggest improvements that provide clear, tangible value.
- Do NOT suggest stylistic changes, comment additions, or trivial refactors.
- Do NOT suggest adding type annotations, docstrings, or documentation.
- "No improvements found" is perfectly acceptable — do not manufacture suggestions.
- Group related improvements into a single suggestion when they should be addressed together.
- Each suggestion should be specific and actionable, referencing exact files and line numbers.

The following issues are already open in this repository — do NOT re-suggest these:
${ISSUE_LIST}

The following PRs are already open in this repository — do NOT re-suggest these:
${PR_LIST}

Respond with ONLY a JSON block in this exact format, no other text:

```json
{
  "improvements": [
    {
      "title": "Short descriptive title (imperative mood)",
      "body": "Detailed description with file references, what to change, and why"
    }
  ]
}
```

If no improvements are worth suggesting, respond with:
```json
{ "improvements": [] }
```
