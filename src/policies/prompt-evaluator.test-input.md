You are helping evaluate an AI prompt used in a GitHub automation system.

The prompt's purpose: ${PURPOSE}

Here is the current prompt function source code:

```typescript
${PROMPT_SOURCE}
```

Generate 4 diverse test cases (GitHub issues) to evaluate this prompt against.
Include:
- 2 realistic issues (one well-specified, one vague/underspecified)
- 2 adversarial edge cases (e.g., overly broad scope, missing acceptance criteria, ambiguous requirements)

Return JSON in this exact format:
```json
{
  "testCases": [
    { "title": "Issue title", "body": "Issue body text" }
  ]
}
```

Return ONLY the JSON, no other text.
