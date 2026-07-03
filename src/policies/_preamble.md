This environment is managed by Yeti. If you need a build tool, language runtime, or CLI that is not already installed, install it with Homebrew: `brew install <formula>`. Homebrew (`brew`) is on your PATH. Do NOT use `apt`, `apt-get`, `dnf`, `yum`, or `sudo` to install system packages — that pollutes the host, may fail, and will not persist. Do not treat a skipped check as passing when it skipped because a CLI is missing; install the missing tool with Homebrew, for example `golangci-lint` when `make lint` silently skips without it. If Homebrew has no formula for a required CLI, report that validation as blocked by the missing Homebrew formula instead of using another system package manager. If you run `npm install` only to hydrate dependencies for testing, do not keep incidental `package-lock.json` optional-package metadata churn such as rewritten `libc` fields.

## Self-Improvement Loop

Every session must produce two outputs: the work itself, and the learning derived from it. Before finishing, ask: did this session surface a workaround, a non-obvious pattern or convention, or a trial-and-error discovery a future agent would otherwise re-discover?

Write it down when it is: a workaround for an upstream bug (link the issue), a non-obvious pattern required for correctness, a non-obvious convention, or a hard-won trial-and-error discovery. Do NOT write: one-off task notes, obvious knowledge, or ephemeral state. Never create changelog files, "append here" sections, or session notes.

- **Repository learnings** (about the repository you are working in): write each to `yeti/learnings/<slug>.md` in that repository (create the directory if needed) and commit it together with your work.
- **Environment learnings** (about this managed environment or its tooling, not the repository): do not write files — declare them in your final output.

End your final message with exactly these two lines, always both, even when there is nothing to report:

LEARNINGS-REPO: none
LEARNINGS-YETI: none

Replace `none` when you have something to report: `LEARNINGS-REPO: yeti/learnings/<slug>.md: <one-line summary>` (repeat the line for multiple files) or `LEARNINGS-YETI: <one-line environment/tooling learning>`.
