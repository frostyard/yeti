# Queue Management

The queue is where all of Yeti's pending work lives. Understanding how to manage it gives you fine-grained control over what gets processed, in what order, and what gets left alone.

## The queue page

Navigate to `/queue` on the dashboard. The page shows every labeled issue and PR across your watched repositories, sorted into categories by state. At a glance, you can see what is waiting on you, what Yeti is about to pick up, and what is frozen in place.

For details on the queue page layout, see the [Dashboard](dashboard.md) guide.

## Skipping items

Sometimes an issue should not be automated. Maybe it requires manual work, or you want to pause Yeti's involvement while you think through the approach. Skipping is how you tell Yeti to leave something alone.

**To skip an item:** Click the Skip button next to it on the queue page.

**What happens:**

- The item's identifier is added to the `skippedItems` array in `config.json`
- All jobs ignore skipped items during processing
- The item still appears on the queue page, marked as skipped
- Labels on GitHub are not affected --- skipping is a Yeti-side control

**To unskip:** Click the Unskip button. The item is removed from `skippedItems` and becomes eligible for processing again.

**When to skip:**

- An issue requires human implementation, not AI
- You want to temporarily shelve something without removing its labels
- A PR needs manual intervention that Yeti keeps trying to "fix"
- An item is causing repeated failures and you want Yeti to move on

Skipped items persist across restarts. They stay skipped until you explicitly unskip them.

## Prioritizing items

When something needs to jump the queue, mark it as priority. Priority items are processed before everything else, across all jobs.

**To prioritize:** Click the Prioritize button on the queue page.

**What happens:**

- The item is added to the `prioritizedItems` array in `config.json`
- The **Priority** label is synced to the issue on GitHub
- All jobs process priority items first, before working through the regular queue
- The item appears highlighted on the queue page

**To remove priority:** Click the button again to deprioritize. The item returns to normal queue ordering.

Priority is useful for urgent fixes, high-value features, or anything that should not wait its turn in the cold.

## Merging from the queue

For pull requests that are ready to land, you can merge directly from the queue page without opening GitHub.

**To merge:** Click the Merge button next to an eligible PR.

Yeti performs a **squash merge**, combining all commits into a single clean commit on the target branch. This is the same merge strategy the `auto-merger` job uses.

!!! tip
    The Merge button only appears for PRs that have passing CI checks. If a PR's checks are still running or have failed, the button will not be available.

## Config-level controls

Beyond per-item skip and priority, several config fields give you broader control over what Yeti works on.

### `allowedRepos`

Limit which repositories Yeti scans. When set, only the listed repos are processed. When `null` or omitted, Yeti watches everything under your configured GitHub owners.

```json
"allowedRepos": ["frontend", "api"]
```

Use this to start small --- watch one or two repos until you are comfortable with the workflow, then expand.

### `pausedJobs`

Pause specific jobs without disabling them entirely. Paused jobs stay registered and visible on the dashboard but skip their scheduled runs.

```json
"pausedJobs": ["improvement-identifier", "doc-maintainer"]
```

Pausing is lighter than removing a job from `enabledJobs`. The job keeps its schedule and state --- it just does not fire until you resume it (from config or the dashboard).

### `enabledJobs`

The master switch. Only jobs listed here will run. An empty array means Yeti sits idle, patiently waiting for instructions.

```json
"enabledJobs": [
  "issue-refiner",
  "issue-worker",
  "ci-fixer",
  "review-addresser",
  "auto-merger",
  "repo-standards"
]
```

See the [Configuration](../getting-started/configuration.md) guide for the full list of available jobs.

---

## Putting it together

A practical approach to queue management:

1. **Start narrow.** Set `allowedRepos` to one or two repos. Enable just the core jobs.
2. **Watch the queue.** Get comfortable with the rhythm of items flowing through states.
3. **Skip liberally.** If something does not feel right for automation, skip it. You can always unskip later.
4. **Prioritize sparingly.** If everything is priority, nothing is. Reserve it for genuinely urgent items.
5. **Expand gradually.** Add repos and jobs as you build confidence in the workflow.

Yeti is patient. It will process your backlog at whatever pace you set, steadily working through the queue like snowfall accumulating overnight --- quietly, consistently, and without complaint.
