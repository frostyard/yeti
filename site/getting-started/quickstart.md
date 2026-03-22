# Quickstart

This guide walks you through Yeti's core workflow: from a fresh issue to a merged pull request. By the end, you will have seen every step of the plan-implement-review-merge loop in action.

## 1. Verify Yeti is running

```bash
curl -s http://localhost:9384/health
```

If this returns a response, the daemon is up. If not, check `journalctl -u yeti -f` for errors.

## 2. Open the dashboard

Navigate to `http://localhost:9384` in your browser (append `?token=your-token` if you set an `authToken`).

The dashboard shows:

- **Job status** --- which jobs are active, idle, or paused
- **Work queue** --- issues and PRs waiting to be processed
- **Logs** --- recent job runs with full output
- **Config** --- live editor for `config.json`

Keep the dashboard open in a tab. You will use it to watch Yeti work.

## 3. Confirm labels are synced

The `repo-standards` job runs on startup and on a daily schedule. It ensures all Yeti labels exist on every repository under your configured owners:

| Label | Purpose |
|---|---|
| **Needs Refinement** | Tells issue-refiner to generate an implementation plan |
| **Needs Plan Review** | Triggers adversarial AI review of the plan (when plan-reviewer is enabled) |
| **Ready** | Signals that a human decision is needed |
| **Refined** | Tells issue-worker to implement the issue as a PR |
| **In Review** | Informational --- an open PR exists for this issue |
| **Priority** | Moves the issue to the front of every processing queue |

If labels are missing on your repo, wait a few minutes for `repo-standards` to run, or trigger it manually from the dashboard.

## 4. Create a test issue

Pick one of the repositories Yeti is watching and create a new issue. Start with something small and well-defined:

> **Title:** Add a timestamp to the footer
>
> **Body:** The page footer should display the current year. Add a `<span>` with the year to the existing footer component.

Clear, scoped issues produce the best plans. Yeti reads the full codebase for context, but a precise description helps it focus.

## 5. Label it for refinement

Add the **Needs Refinement** label to your issue.

This is the trigger. Within the next polling interval (5 minutes by default), the `issue-refiner` job will:

1. Clone or update the repo's worktree
2. Read the codebase and the issue description
3. Generate a detailed **Implementation Plan** comment on the issue
4. Remove the `Needs Refinement` label

Watch the dashboard --- you will see the job move from idle to active, and a new entry will appear in the logs.

## 6. Review the plan

Go back to your issue on GitHub. Yeti will have posted a comment with a structured implementation plan: which files to modify, what changes to make, and how to verify them.

Read through it. This is the checkpoint where your judgment matters most.

- **If the plan looks good:** Move on to the next step.
- **If it needs adjustment:** Post a comment with your feedback and re-add the `Needs Refinement` label. Yeti will generate a revised plan that incorporates your notes.
- **If plan-reviewer is enabled:** You will also see an adversarial review comment that critiques the plan. The issue will have the `Ready` label, indicating it is waiting for your decision.

## 7. Approve the plan

Add the **Refined** label to the issue.

This tells the `issue-worker` job to implement the plan. On its next polling cycle, it will:

1. Create a fresh worktree on a new branch
2. Invoke the AI with the plan and full codebase context
3. Commit the changes and push the branch
4. Open a pull request linked to the issue
5. Add the `In Review` label to the issue

## 8. Watch the PR

The pull request appears on GitHub like any other. Yeti's PR description will reference the original issue and summarize the changes.

CI will run. If checks fail, the `ci-fixer` job reads the failure logs and pushes a fix --- no intervention needed on your part. You can watch this happen in real time on the dashboard.

## 9. Review and iterate

Review the PR as you normally would. If you leave comments requesting changes, the `review-addresser` job picks them up and pushes new commits to address them.

The cycle repeats until the PR is in a clean state: tests passing, comments resolved.

## 10. Merge

You have two options:

- **Merge manually** --- Click the merge button on GitHub when you are satisfied.
- **Let auto-merger handle it** --- If the `auto-merger` job is enabled, it will merge PRs that meet all criteria: CI passing, required approvals present, and no unresolved review threads. Dependency updates and documentation PRs merge on green CI without waiting for manual approval.

Either way, the issue closes when the PR merges. One less item in the backlog.

---

## What to try next

Now that you have seen the full loop, here are some things to explore:

- **Priority issues** --- Add the `Priority` label to an issue and watch it jump to the front of the queue
- **Skip or pause** --- Use the dashboard config to pause specific jobs or skip individual issues
- **Multiple repos** --- Remove `allowedRepos` from your config to let Yeti scan all repos under your org
- **Discord** --- Set up the Discord bot to create issues, trigger analysis, and receive notifications without leaving your chat

For a deeper look at day-to-day usage patterns, see the [Daily Workflow](../usage/daily-workflow.md) guide.
