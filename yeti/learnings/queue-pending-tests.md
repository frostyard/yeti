# Queue Pending Tests

Tests that need Claude queue items to remain pending should set `MAX_CLAUDE_WORKERS = 1` and occupy the worker with a blocker promise. Do not use `MAX_CLAUDE_WORKERS = 0` for this: zero workers are treated as a disabled backend and `enqueue()` rejects immediately.
