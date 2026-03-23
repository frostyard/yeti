# Yeti

**A tireless automation daemon that turns your GitHub issues into pull requests while you sleep.**

Yeti is a self-hosted GitHub automation service that watches your repositories, plans work from issues, implements changes as pull requests, fixes broken CI, and merges when everything is green. It runs quietly on your own infrastructure --- a single Node.js process under systemd --- and keeps a steady pace through your backlog like something well-adapted to cold, remote terrain.

---

## The problem

Software teams generate issues faster than they close them. Every issue follows the same cycle: someone triages it, someone plans the approach, someone writes the code, CI breaks, someone fixes it, someone reviews, someone merges. Each handoff is a context switch. Each context switch is a delay. The backlog grows.

Small teams feel this most. You know *what* needs to happen, but the mechanical work of planning, branching, implementing, and shepherding PRs through review eats your hours. The interesting decisions --- what to build, whether the approach is right, whether the code is good --- get buried under process.

## The solution

Yeti automates the loop between "this issue needs work" and "here's a PR ready for your review."

You label an issue. Yeti reads the codebase, writes an implementation plan, and posts it as a comment. You review the plan --- refine it if needed, approve it when it looks right. Yeti checks out a worktree, generates the implementation, opens a PR, and moves on to the next item. If CI fails, it reads the logs and pushes a fix. If a reviewer leaves comments, it addresses them. When approvals land and checks pass, it merges.

You stay in the driver's seat. Yeti handles the legwork.

## How it works

Yeti runs as a background daemon that polls your GitHub repositories on configurable intervals:

1. **Scan** --- Discovers issues and PRs that need attention across all your repos
2. **Plan** --- Reads the codebase and generates detailed implementation plans for labeled issues
3. **Implement** --- Creates branches, writes code in isolated git worktrees, opens pull requests
4. **Fix** --- Monitors CI results and automatically fixes failures
5. **Address** --- Responds to review comments on open PRs
6. **Merge** --- Auto-merges PRs that meet your criteria (passing checks, approvals, clean diff)

Each step runs independently on its own schedule. Work is processed in isolated worktrees, so concurrent tasks never interfere with each other.

## Human-in-the-loop

Yeti is not autonomous. It is deliberate about where it requires your judgment:

- **Plans require approval.** Yeti posts an implementation plan on the issue. You read it, refine it if needed, and add the `Refined` label when it looks right. No label, no PR.
- **PRs require review.** Yeti opens PRs like any other contributor. Your normal review process applies.
- **Merging requires criteria.** Auto-merge only triggers when checks pass, approvals exist, and the PR meets your configured standards. Exceptions: dependency updates and documentation PRs, which are low-risk and merge on green CI.

You decide what gets built and whether the approach is correct. Yeti handles the implementation and shepherds it through your pipeline.

## What your workflow looks like

**Without Yeti:** Issue sits in backlog. Someone picks it up days later. Spends time understanding the codebase. Writes code. CI breaks. Fixes CI. Waits for review. Addresses comments. Merges. Repeats.

**With Yeti:**

1. You create an issue describing what you want
2. Add the `Needs Refinement` label
3. Within minutes, Yeti posts an implementation plan
4. You review the plan, add the `Refined` label
5. Yeti opens a PR with the implementation
6. You review code at your convenience
7. Yeti addresses review comments, fixes CI if needed
8. PR merges when it is ready

The cold reality: most of the time you spent on an issue was not making decisions --- it was executing them. Yeti shifts your time back to the decisions.

## Features

- **11 automated jobs** --- issue refinement, implementation, CI fixing, review addressing, auto-merging, documentation maintenance, repo standards enforcement, improvement identification, issue auditing, plan review, and error triage
- **Web dashboard** --- Real-time view of job status, work queue, logs, and configuration. Runs on port 9384.
- **Discord bot** --- Create issues, analyze PRs, trigger jobs, and get notifications from your Discord server
- **Multi-repo** --- Monitors all repositories under your configured GitHub organizations
- **Multi-backend AI** --- Route different jobs to Claude, Copilot, or Codex with per-job model overrides
- **Priority queue** --- Mark issues as `Priority` to move them to the front of every queue
- **Live configuration** --- Most settings reload without restart. Pause jobs, skip items, adjust intervals from the dashboard.
- **Auto-updates** --- A systemd timer checks for new releases every 60 seconds, downloads them, and restarts with health check and automatic rollback
- **Crash recovery** --- On startup, Yeti detects orphaned tasks from prior crashes, cleans up worktrees, and resumes cleanly

## Get started

Ready to let Yeti settle in? Installation takes about five minutes.

[Install Yeti](getting-started/installation.md){ .md-button .md-button--primary }
