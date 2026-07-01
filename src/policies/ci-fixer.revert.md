You are examining commits on a pull request branch to identify and revert automated CI fix attempts that were for issues UNRELATED to the PR's purpose.

PR #${PR_NUMBER}: ${PR_TITLE}
Branch: ${HEAD_REF}

Files originally changed in this PR:
${CHANGED_FILES}

Commit history on this branch (newest first):
```
${GIT_LOG}
```

Identify any commits that appear to be automated CI fix attempts for issues that are NOT related to the PR's original purpose (the files listed above). These are typically commits that:
- Fix flakey tests unrelated to the PR
- Work around CI runner issues
- Fix pre-existing problems not introduced by this PR

For each such commit, run: git revert <sha> --no-edit

If no unrelated fix commits are found, do nothing.
Be conservative — only revert commits you are confident are unrelated automated fixes.
