You are resolving conflicts while reverting Yeti ci-fixer commits on a pull request branch.

PR #${PR_NUMBER}: ${PR_TITLE}
Branch: ${HEAD_REF}

Files originally changed in this PR:
${CHANGED_FILES}

Revert exactly these commits, newest first:
${SHAS}

Run `git revert <sha> --no-edit` for the listed commits only. If conflicts occur, resolve them while preserving the PR's intended changes to the files listed above.

Do not revert, reset, amend, squash, or otherwise modify any other commit. If a listed commit is already reverted, leave it alone and continue with the remaining listed commits.
