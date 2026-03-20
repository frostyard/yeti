# Job Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `enabledJobs` config field that controls which jobs the scheduler registers, with live-reload support.

**Architecture:** Filter the hardcoded `jobs` array in `main.ts` against a new `ENABLED_JOBS` config export before passing to `startJobs()`. Add `addJob()`/`removeJob()` methods to the scheduler for live-reload. Empty/missing `enabledJobs` defaults to `[]` (no jobs run).

**Tech Stack:** TypeScript, Node.js, Vitest

**Spec:** `.superpowers/specs/2026-03-20-job-configuration-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/config.ts` | Modify | Add `enabledJobs` to `ConfigFile`, `loadConfig()`, exports, `reloadConfig()` |
| `src/scheduler.ts` | Modify | Add `addJob()` and `removeJob()` to `Scheduler` interface and implementation |
| `src/scheduler.test.ts` | Modify | Add tests for `addJob()` and `removeJob()` |
| `src/main.ts` | Modify | Filter jobs by `enabledJobs`, add live-reload diffing |
| `deploy/install.sh` | Modify | Add `enabledJobs` to bootstrap config template |

---

### Task 1: Add `enabledJobs` to config

**Files:**
- Modify: `src/config.ts:43-78` (ConfigFile interface)
- Modify: `src/config.ts:164-168` (loadConfig body)
- Modify: `src/config.ts:176` (loadConfig return)
- Modify: `src/config.ts:198-200` (exports)
- Modify: `src/config.ts:232-252` (reloadConfig)

- [ ] **Step 1: Add `enabledJobs` to `ConfigFile` interface**

In `src/config.ts`, add after `prioritizedItems` (line 77):

```typescript
  enabledJobs?: string[];
```

- [ ] **Step 2: Add parsing in `loadConfig()`**

In `src/config.ts`, add after `const prioritizedItems = ...` (line 168):

```typescript
  const enabledJobs = file.enabledJobs ?? [];
```

- [ ] **Step 3: Add to `loadConfig()` return value**

In `src/config.ts`, add `enabledJobs` to the return object on line 176.

- [ ] **Step 4: Add export**

In `src/config.ts`, add after the `PRIORITIZED_ITEMS` export (line 200):

```typescript
export let ENABLED_JOBS: readonly string[] = config.enabledJobs;
```

- [ ] **Step 5: Add to `reloadConfig()`**

In `src/config.ts`, add after `PRIORITIZED_ITEMS = fresh.prioritizedItems;` (line 250):

```typescript
  ENABLED_JOBS = fresh.enabledJobs;
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/config.ts
git commit -m "feat: add enabledJobs config field"
```

---

### Task 2: Add `addJob()` to scheduler

**Files:**
- Modify: `src/scheduler.ts:15-26` (Scheduler interface)
- Modify: `src/scheduler.ts:36-111` (startJobs implementation)
- Modify: `src/scheduler.ts:227` (return statement)
- Test: `src/scheduler.test.ts`

- [ ] **Step 1: Write failing test — addJob registers and ticks an interval job**

In `src/scheduler.test.ts`, add inside the `describe("scheduler")` block after the last test (before the closing `});`):

```typescript
  it("addJob registers and starts ticking a new interval job", async () => {
    const scheduler = startJobs([]);

    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.addJob(makeJob("dynamic-job", runFn, 1000));

    await vi.advanceTimersByTimeAsync(0); // first tick
    expect(runFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(runFn).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/scheduler.test.ts -t "addJob registers and starts ticking"`
Expected: FAIL — `scheduler.addJob is not a function`

- [ ] **Step 3: Add `addJob` to `Scheduler` interface**

In `src/scheduler.ts`, add to the `Scheduler` interface after `jobScheduleInfo()` (line 25):

```typescript
  addJob(job: Job): void;
```

- [ ] **Step 4: Implement `addJob` in `startJobs()`**

In `src/scheduler.ts`, add before the `return` statement (before line 227):

```typescript
  function addJob(job: Job): void {
    if (draining) {
      log.warn(`Cannot add job ${job.name} — scheduler is draining`);
      return;
    }
    if (ticks.has(job.name)) {
      log.warn(`Job ${job.name} is already registered — skipping addJob`);
      return;
    }

    runningFlags.set(job.name, false);
    pausedFlags.set(job.name, false);
    scheduleConfigs.set(job.name, { intervalMs: job.intervalMs, scheduledHour: job.scheduledHour });
    jobTimers.set(job.name, []);

    const tick = async (manual?: boolean) => {
      if (draining) return;
      if (!manual && pausedFlags.get(job.name)) return;
      if (runningFlags.get(job.name)) {
        log.info(`Skipping ${job.name} — previous run still in progress`);
        return;
      }

      const runId = crypto.randomUUID();
      runningFlags.set(job.name, true);

      try {
        insertJobRun(runId, job.name);
      } catch {
        // Don't block the job if run tracking fails
      }

      await withRunContext(runId, async () => {
        log.info(`Starting job: ${job.name}`);
        try {
          await job.run();
          log.info(`Finished job: ${job.name}`);
          try { completeJobRun(runId, "completed"); } catch { /* best effort */ }
        } catch (err) {
          try { completeJobRun(runId, "failed"); } catch { /* best effort */ }
          reportError(`scheduler:${job.name}`, job.name, err);
        } finally {
          runningFlags.set(job.name, false);
        }
      });
    };

    ticks.set(job.name, tick);

    const timers = jobTimers.get(job.name)!;
    if (job.scheduledHour !== undefined) {
      const delay = msUntilHour(job.scheduledHour);
      log.info(`Scheduling ${job.name} for ${job.scheduledHour}:00 (in ${Math.round(delay / 60000)} min)`);
      if (job.runOnStart) tick();
      timers.push(setTimeout(() => {
        tick();
        timers.push(setInterval(tick, 24 * 60 * 60 * 1000));
      }, delay));
    } else {
      // No stagger needed for single dynamic adds (stagger is only for bulk startup)
      tick();
      timers.push(setInterval(tick, job.intervalMs));
    }
  }
```

- [ ] **Step 5: Add `addJob` to return statement**

In `src/scheduler.ts`, add `addJob` to the return object on line 227.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/scheduler.test.ts -t "addJob registers and starts ticking"`
Expected: PASS

- [ ] **Step 7: Write test — addJob for a scheduledHour job**

```typescript
  it("addJob registers and schedules a scheduledHour job", async () => {
    vi.setSystemTime(new Date("2025-01-01T10:00:00"));
    const scheduler = startJobs([]);

    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.addJob({ name: "dynamic-sched", intervalMs: 0, scheduledHour: 12, run: runFn });

    await vi.advanceTimersByTimeAsync(0);
    expect(runFn).toHaveBeenCalledTimes(0); // not until scheduled hour

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // advance to 12:00
    expect(runFn).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/scheduler.test.ts -t "addJob registers and schedules"`
Expected: PASS

- [ ] **Step 9: Write test — addJob during drain is a no-op**

```typescript
  it("addJob during drain is a no-op", async () => {
    const scheduler = startJobs([]);
    const drainPromise = scheduler.drain();
    await vi.advanceTimersByTimeAsync(500);
    await drainPromise;

    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.addJob(makeJob("too-late", runFn, 1000));

    await vi.advanceTimersByTimeAsync(5000);
    expect(runFn).not.toHaveBeenCalled();
    expect(scheduler.jobStates().has("too-late")).toBe(false);
    expect(scheduler.jobScheduleInfo().has("too-late")).toBe(false);
  });
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run src/scheduler.test.ts -t "addJob during drain"`
Expected: PASS

- [ ] **Step 11: Write test — addJob for already-registered job is a no-op**

```typescript
  it("addJob for an already-registered job is a no-op", async () => {
    const run1 = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("existing-job", run1, 1000)]);

    await vi.advanceTimersByTimeAsync(0);
    expect(run1).toHaveBeenCalledTimes(1);

    const run2 = vi.fn().mockResolvedValue(undefined);
    scheduler.addJob(makeJob("existing-job", run2, 1000));

    await vi.advanceTimersByTimeAsync(1000);
    expect(run1).toHaveBeenCalledTimes(2); // original still ticking
    expect(run2).not.toHaveBeenCalled();   // duplicate ignored

    scheduler.stop();
  });
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run src/scheduler.test.ts -t "addJob for an already-registered"`
Expected: PASS

- [ ] **Step 13: Run all scheduler tests**

Run: `npx vitest run src/scheduler.test.ts`
Expected: All tests PASS

- [ ] **Step 14: Commit**

```bash
git add src/scheduler.ts src/scheduler.test.ts
git commit -m "feat: add addJob method to scheduler"
```

---

### Task 3: Add `removeJob()` to scheduler

**Files:**
- Modify: `src/scheduler.ts:15-26` (Scheduler interface)
- Modify: `src/scheduler.ts` (implementation, before return)
- Modify: `src/scheduler.ts` (return statement)
- Test: `src/scheduler.test.ts`

- [ ] **Step 1: Write failing test — removeJob stops ticks**

```typescript
  it("removeJob stops ticks and cleans up state", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("remove-me", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // initial tick
    expect(runFn).toHaveBeenCalledTimes(1);

    scheduler.removeJob("remove-me");

    await vi.advanceTimersByTimeAsync(5000);
    expect(runFn).toHaveBeenCalledTimes(1); // no more ticks

    expect(scheduler.jobStates().has("remove-me")).toBe(false);
    expect(scheduler.jobScheduleInfo().has("remove-me")).toBe(false);

    scheduler.stop();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/scheduler.test.ts -t "removeJob stops ticks"`
Expected: FAIL — `scheduler.removeJob is not a function`

- [ ] **Step 3: Add `removeJob` to `Scheduler` interface**

In `src/scheduler.ts`, add to the `Scheduler` interface:

```typescript
  removeJob(name: string): void;
```

- [ ] **Step 4: Implement `removeJob` in `startJobs()`**

Add before the `return` statement:

```typescript
  function removeJob(name: string): void {
    if (!ticks.has(name)) return; // unknown job — no-op

    clearJobTimers(name);
    jobTimers.delete(name);
    ticks.delete(name);
    pausedFlags.delete(name);
    scheduleConfigs.delete(name);
    // Only delete runningFlags if the job isn't currently running.
    // If it is running, the finally block will set it to false (zombie entry — harmless).
    if (!runningFlags.get(name)) {
      runningFlags.delete(name);
    }
    log.info(`Removed job: ${name}`);
  }
```

- [ ] **Step 5: Add `removeJob` to return statement**

Add `removeJob` to the return object.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/scheduler.test.ts -t "removeJob stops ticks"`
Expected: PASS

- [ ] **Step 7: Write test — removeJob on running job lets it complete**

```typescript
  it("removeJob on a currently-running job lets it complete", async () => {
    let resolveJob: () => void;
    const longRunning = () =>
      new Promise<void>((resolve) => {
        resolveJob = resolve;
      });
    const runFn = vi.fn().mockImplementation(longRunning);

    const scheduler = startJobs([makeJob("remove-running", runFn, 1000)]);

    await vi.advanceTimersByTimeAsync(0); // start the job
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(scheduler.jobStates().get("remove-running")).toBe(true);

    scheduler.removeJob("remove-running");

    // Job should still be running (current run completes naturally)
    expect(scheduler.jobStates().get("remove-running")).toBe(true);

    // Complete the job
    resolveJob!();
    await vi.advanceTimersByTimeAsync(0);

    // No more ticks after completion
    await vi.advanceTimersByTimeAsync(5000);
    expect(runFn).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/scheduler.test.ts -t "removeJob on a currently-running"`
Expected: PASS

- [ ] **Step 9: Write test — removeJob for unknown job is a no-op**

```typescript
  it("removeJob for an unknown job is a no-op", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const scheduler = startJobs([makeJob("keep-me", runFn, 1000)]);

    // Should not throw
    scheduler.removeJob("nonexistent-job");

    await vi.advanceTimersByTimeAsync(0);
    expect(runFn).toHaveBeenCalledTimes(1); // unrelated job unaffected

    scheduler.stop();
  });
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run src/scheduler.test.ts -t "removeJob for an unknown"`
Expected: PASS

- [ ] **Step 11: Run all scheduler tests**

Run: `npx vitest run src/scheduler.test.ts`
Expected: All tests PASS

- [ ] **Step 12: Commit**

```bash
git add src/scheduler.ts src/scheduler.test.ts
git commit -m "feat: add removeJob method to scheduler"
```

---

### Task 4: Filter jobs by `enabledJobs` in main.ts

**Files:**
- Modify: `src/main.ts:1-5` (imports)
- Modify: `src/main.ts:99-191` (jobs section)

- [ ] **Step 1: Add `ENABLED_JOBS` to the import**

In `src/main.ts` line 4, add `ENABLED_JOBS` to the import from `./config.js`:

```typescript
import { INTERVALS, SCHEDULES, LOG_RETENTION_DAYS, LOG_RETENTION_PER_JOB, WORK_DIR, WHATSAPP_ENABLED, ENABLED_JOBS, onConfigChange } from "./config.js";
```

- [ ] **Step 2: Add filtering logic after the jobs array**

In `src/main.ts`, replace lines 190-191:

```typescript
const scheduler = startJobs(jobs, config.PAUSED_JOBS);
const server = createServer(scheduler);
```

with:

```typescript
// ── Job filtering ──

const knownJobNames = new Set(jobs.map(j => j.name));
for (const name of ENABLED_JOBS) {
  if (!knownJobNames.has(name)) {
    log.warn(`Unknown job in enabledJobs: "${name}" — ignoring`);
  }
}

const enabledSet = new Set(ENABLED_JOBS);
const enabledJobs = jobs.filter(j => enabledSet.has(j.name));
const skippedJobs = jobs.filter(j => !enabledSet.has(j.name));

if (skippedJobs.length > 0) {
  log.info(`Skipping disabled jobs: ${skippedJobs.map(j => j.name).join(", ")}`);
}
if (enabledJobs.length === 0) {
  log.warn("No jobs enabled — yeti is running but idle. Set enabledJobs in config.");
}

const scheduler = startJobs(enabledJobs, config.PAUSED_JOBS);
const server = createServer(scheduler);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: filter jobs by enabledJobs config at startup"
```

---

### Task 5: Add live-reload diffing for `enabledJobs`

**Files:**
- Modify: `src/main.ts:193-232` (onConfigChange callback)

- [ ] **Step 1: Add `prevEnabledJobs` tracking**

In `src/main.ts`, after `let prevSchedules = { ...SCHEDULES };` add:

```typescript
let prevEnabledJobs = new Set(ENABLED_JOBS);
```

- [ ] **Step 2: Add enabledJobs diffing in the `onConfigChange` callback**

In `src/main.ts`, inside the `onConfigChange(() => { ... })` callback, after the pause-state sync block (after the last `}` of the `for (const name of schedulerPaused)` loop), add:

```typescript

  // Sync enabled jobs
  const newEnabled = new Set(config.ENABLED_JOBS);

  for (const name of newEnabled) {
    if (!prevEnabledJobs.has(name)) {
      const job = jobs.find(j => j.name === name);
      if (job) {
        scheduler.addJob(job);
        log.info(`Enabled job: ${name}`);
      }
    }
  }

  for (const name of prevEnabledJobs) {
    if (!newEnabled.has(name)) {
      scheduler.removeJob(name);
      log.info(`Disabled job: ${name}`);
    }
  }

  prevEnabledJobs = newEnabled;
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: live-reload enabledJobs config changes"
```

---

### Task 6: Update deploy/install.sh bootstrap template

**Files:**
- Modify: `deploy/install.sh:46-81` (config template)

- [ ] **Step 1: Add `enabledJobs` to the JSON template**

In `deploy/install.sh`, add after `"prioritizedItems": []` (line 80), adding a comma after `[]`:

```json
  "prioritizedItems": [],
  "enabledJobs": []
```

- [ ] **Step 2: Add a log line listing available job names**

In `deploy/install.sh`, after the `log "Created $CONFIG_FILE ..."` line (line 84), add:

```bash
  log "Available jobs for enabledJobs: issue-worker, issue-refiner, ci-fixer, review-addresser, doc-maintainer, auto-merger, repo-standards, improvement-identifier, issue-auditor, triage-yeti-errors"
```

- [ ] **Step 3: Commit**

```bash
git add deploy/install.sh
git commit -m "feat: add enabledJobs to install.sh bootstrap config"
```

---

### Task 7: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `yeti/` docs (if config docs exist)

- [ ] **Step 1: Update CLAUDE.md config description**

In `CLAUDE.md`, in the `config.ts` description under Architecture > Core modules, add a mention of `ENABLED_JOBS` alongside the existing `LABELS`, `INTERVALS`, `SCHEDULES` exports.

- [ ] **Step 2: Check for config documentation in yeti/ folder**

Run: `ls yeti/`

If config documentation exists, add `enabledJobs` to it. Document:
- Field name: `enabledJobs`
- Type: `string[]`
- Default: `[]` (no jobs run)
- Live-reloadable: yes
- Available values: the 10 job names
- Migration note: existing configs without this field will have no jobs start

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md yeti/
git commit -m "docs: document enabledJobs config field"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Build the project**

Run: `npm run build`
Expected: Build succeeds
