# Autonomy Config Replacement

`writeConfig()` deep-merges only `intervals`, `schedules`, and `jobAi`. Keep `autonomy` out of that special-case list: dashboard saves submit the complete per-repo autonomy map, and whole-value replacement is required so removing an override writes `autonomy: {}` instead of preserving old entries.
