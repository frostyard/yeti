# Daily Workflow

Yeti keeps a steady rhythm in the background. Your job is to steer --- decide what gets built, review the plans, and approve the results. Yeti handles the rest, quietly working through your backlog like something that thrives in conditions others would rather avoid.

## Your role

You manage two things: **issues** and **reviews**. Yeti handles everything in between.

The division is simple. You make decisions. Yeti executes them. Labels are how you communicate what you want --- a lightweight signaling system that keeps the whole operation moving without meetings, standups, or Slack threads.

## The typical cycle

### 1. An issue appears

Either you create one manually, or Yeti surfaces improvements on its own via the `improvement-identifier` job. Either way, it starts as a normal GitHub issue.

### 2. Label it for planning

Add the **Needs Refinement** label. This tells Yeti to read the codebase, understand the issue, and draft a plan.

### 3. Yeti posts a plan

Within the next polling interval, Yeti posts an **## Implementation Plan** comment on the issue. This is a structured breakdown: which files to touch, what to change, how to verify it works.

If `plan-reviewer` is enabled, Yeti also posts a **## Plan Review** --- an adversarial critique of its own plan. Think of it as a second opinion that arrives before you even ask.

Yeti adds the **Ready** label. The trail is yours now.

### 4. You review the plan

Read the implementation plan. You have two options:

- **Approve it.** Add the **Refined** label. Yeti picks it up and starts implementation.
- **Request changes.** Post a comment with your feedback. Yeti will incorporate your notes and generate a revised plan on the next cycle.

This is the most important checkpoint in the whole workflow. A good plan produces a good PR. Take the time to read it.

### 5. Yeti implements

Once an issue has the **Refined** label, the `issue-worker` job creates a fresh worktree, generates the implementation, and opens a pull request. Yeti adds the **In Review** label to the issue so you know a PR is out.

### 6. You review the PR

Review the pull request as you normally would. Leave comments, request changes, approve --- the usual flow.

If you leave review comments, the `review-addresser` job picks them up and pushes new commits to address them. No need to ping anyone or wait for a response.

### 7. It merges

If `auto-merger` is enabled and the PR meets all criteria (CI passing, approvals present, no unresolved threads), it merges automatically. Otherwise, merge it yourself when you are satisfied.

The issue closes. The backlog gets a little shorter.

---

## Multi-PR issues

Some issues are too large for a single pull request. Yeti handles these by breaking the work into phased PRs --- Part 1/3, Part 2/3, and so on.

Each phase is a separate PR. When one phase merges, Yeti re-labels the issue as **Refined** to kick off the next phase. You review each phase independently, but you only had to approve the plan once.

---

## Background jobs

Several jobs run on their own schedules without needing your attention. They are the cold-weather maintenance crew:

| Job | What it does | Schedule |
|---|---|---|
| **ci-fixer** | Reads CI failure logs and pushes fixes. Also resolves merge conflicts. | Every 5 minutes |
| **doc-maintainer** | Updates project documentation to reflect code changes | Nightly |
| **repo-standards** | Syncs Yeti's label set to all watched repositories | Daily |
| **issue-auditor** | Audits label state across repos, reports anomalies via Discord | Nightly |
| **triage-yeti-errors** | Investigates Yeti's own `[yeti-error]` issues and triages them | Every 5 minutes |
| **improvement-identifier** | Scans codebases for potential improvements and creates issues | Daily |

You do not need to interact with these directly. They run, they report, they keep things tidy. Check the dashboard logs if you want to see what they have been up to.

---

## A typical day

A productive day with Yeti looks something like this:

1. **Morning** --- Open the dashboard. Check the queue page for items marked "Human attention." These are plans waiting for your review.
2. **Review plans** --- Read the implementation plans Yeti posted overnight. Approve the good ones with the **Refined** label. Leave feedback on any that need adjustment.
3. **Review PRs** --- Check open PRs that Yeti created. Review the code, leave comments if needed. Yeti addresses them.
4. **Create new issues** --- File issues for things you want done. Label them **Needs Refinement** when you are ready for Yeti to plan them.
5. **End of day** --- Merge anything that looks good. Yeti keeps working through the night, and you will have fresh plans and PRs waiting in the morning.

The rhythm settles in quickly. You spend your time on decisions --- what to build, whether the approach is right, whether the code is good --- and Yeti handles the mechanical work of planning, implementing, and shepherding changes through your pipeline.
