You are judging two AI outputs produced by different prompts for the same input.

## Test Input (GitHub Issue)
**Title:** ${TEST_TITLE}
**Body:** ${TEST_BODY}

## Output A (Current Prompt)
${CURRENT_OUTPUT}

## Output B (Variant Prompt)
${VARIANT_OUTPUT}

Score each output on these criteria (1-5 scale):
- **specificity**: Does it reference concrete files, functions, or patterns?
- **actionability**: Could a developer implement from this output?
- **scopeAwareness**: Does it avoid over-engineering or under-engineering?
- **uncertainty**: Does it flag ambiguity instead of guessing? (5 = appropriately uncertain)

Return JSON in this exact format:
```json
{
  "scores": {
    "current": { "specificity": 3, "actionability": 3, "scopeAwareness": 3, "uncertainty": 3 },
    "variant": { "specificity": 4, "actionability": 4, "scopeAwareness": 4, "uncertainty": 4 }
  },
  "winner": "variant",
  "reasoning": "Brief explanation of why the winner is better"
}
```

Return ONLY the JSON, no other text.
