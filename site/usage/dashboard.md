# Dashboard

Yeti's web dashboard gives you a real-time view of everything the daemon is doing. It runs at `http://localhost:9384` by default --- a warm outpost where you can monitor all the activity happening across your repositories.

## Authentication

If you set `authToken` in your config, the dashboard requires authentication. Pass your token as a query parameter:

```
http://localhost:9384?token=your-secret-token
```

Without an `authToken` configured, the dashboard is open to anyone who can reach the port. This is fine on private networks or behind a reverse proxy with its own auth layer.

## Main page

The root page (`/`) is your command center. It shows every registered job with:

| Column | Description |
|---|---|
| **Job name** | The job identifier (e.g., `issue-refiner`, `ci-fixer`) |
| **Status** | Current state: idle, running, or paused |
| **Last run** | When the job last executed, with duration |
| **Next run** | Countdown to the next scheduled execution |

### Controls

Each job has action buttons:

- **Trigger** --- Run the job immediately, regardless of its schedule. Useful when you have just labeled an issue and do not want to wait for the next polling interval.
- **Pause / Resume** --- Temporarily stop a job from running on its schedule. The job stays registered but skips its intervals until resumed.
- **Cancel** --- Abort a currently running Claude task. Sends SIGTERM to the AI process, with SIGKILL escalation if it does not stop gracefully.

## Queue page

The queue page (`/queue`) shows all labeled issues and PRs across your watched repositories, organized into two categories that make it clear who needs to act next.

### Human attention

Items waiting on you. These have the **Ready** label --- Yeti has done its part and is waiting for your decision:

- Plans ready for review (approve with **Refined** or post feedback)
- Any item that needs a human judgment call

### Yeti attention

Items Yeti will process on its next cycle. These are in various stages of the pipeline:

| State | Meaning |
|---|---|
| Needs Refinement | Waiting for issue-refiner to generate a plan |
| Refined | Waiting for issue-worker to implement |
| Needs Review Addressing | PR has unaddressed review comments |
| Auto-mergeable | PR meets merge criteria, waiting for auto-merger |
| Needs Triage | Error issue waiting for triage |
| Needs Plan Review | Plan waiting for adversarial review |

### Item details

Each queue item shows:

- **Repository** name
- **Issue or PR number** and title
- **Current labels**

### Actions

For items in the queue, you can:

- **Merge** --- For PRs that are ready, trigger a squash merge directly from the dashboard
- **Skip** --- Tell Yeti to ignore this item (persisted in config)
- **Prioritize** --- Move this item to the front of all processing queues

## Logs page

The logs page (`/logs`) is where you go to understand what Yeti has been doing --- and what went wrong when something did.

### Filtering

Narrow down the log list by:

- **Job name** --- Show runs for a specific job only
- **Status** --- Filter by success or failure
- **Search text** --- Free-text search across log output

### Log entries

Each entry shows:

| Field | Description |
|---|---|
| **Job** | Which job produced this log |
| **Timestamp** | When the run started |
| **Duration** | How long it took |
| **Status** | Success or failed |

Click into any entry to see the full log output --- every line the job produced during that run.

### Issue-specific view

You can also view all log entries related to a specific issue. This is useful when you want to trace the full history of how Yeti processed a particular item: the refinement run, the implementation run, any CI fix attempts, and review addressing.

## Repos page

The repos page (`/repos`) shows all configured repositories with their current activity and recent history. It is the central place for understanding which repos Yeti is watching and what work is happening in each one.

### Summary

At the top, a summary shows:

- **Configured Repos** --- How many repositories are in the `allowedRepos` config
- **Active Repos** --- How many repos currently have items in the work queue

### Per-repo detail

Each configured repository gets its own section showing:

- **GitHub links** --- Direct links to the repo's Issues and Pull Requests pages
- **Active items** --- Issues and PRs currently in the work queue, with labels, check status, and links to both Yeti logs and GitHub
- **Recently Completed** --- A collapsible list of tasks Yeti finished in the last 7 days, showing the job name, item number, and completion time

### Adding repos

If `allowedRepos` is set in your config, the page shows an **Add Repo** button that lists other repositories in your GitHub org that are not yet configured. Selecting one adds it to `allowedRepos` via the config file. If no `allowedRepos` filter is set (all org repos are included), the page notes this instead.

## Jobs page

The jobs page (`/jobs`) gives you a comprehensive view of every registered job --- both enabled and disabled. It is the go-to place for understanding what Yeti is configured to do and how each job is running.

Each job row shows:

| Column | Description |
|---|---|
| **Job** | Name and a short description of what the job does |
| **Enabled** | Whether the job is in the `enabledJobs` config list |
| **Backend** | Which AI backend the job uses (Claude or Copilot) |
| **Model** | The AI model override, or "default" |
| **Schedule** | Interval (e.g., "Every 5 min") or daily hour (e.g., "Daily at 1:00") |
| **Status** | Running, Paused, Idle, or Disabled |
| **Last Run** | Relative time since the last execution |
| **Next Run** | Countdown to the next scheduled run |
| **Logs** | Link to the latest run's log (or "Live" if currently running) |

### Controls

Enabled jobs have action buttons:

- **Run** --- Trigger the job immediately
- **Pause / Resume** --- Toggle whether the job runs on its schedule

The page live-updates every 10 seconds, so you can leave it open to monitor job activity.

## Config page

The config page (`/config`) lets you view and edit Yeti's configuration directly from the browser.

- **View** --- All current configuration values are displayed. Sensitive fields like tokens are masked.
- **Edit** --- Modify `config.json` in-place. Changes are saved to disk and trigger a live reload --- no restart needed for most fields.

See the [Configuration](../getting-started/configuration.md) guide for details on which fields reload live and which require a restart.

## Themes

The dashboard supports three display modes:

- **Light** --- Clean and bright, for those rare sunny days
- **Dark** --- Easy on the eyes during long sessions or late-night monitoring
- **System** --- Follows your OS preference automatically

Toggle between them from the dashboard header.
