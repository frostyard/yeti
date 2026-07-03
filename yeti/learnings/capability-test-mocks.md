# Capability Test Mocks

Tests that import `api.ts` or any module that reaches `capability.ts` must mock the full autonomy config surface from `config.ts`: `repoAutonomy`, `AUTONOMY_MAP`, and `DEFAULT_AUTONOMY`. `capability.ts` statically imports all three, so omitting any of them can fail module loading before the specific test logic runs.
