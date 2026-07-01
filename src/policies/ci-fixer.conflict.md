You are resolving merge conflicts on a pull request in the repository ${FULL_NAME}.
PR #${PR_NUMBER}: ${PR_TITLE}
Branch: ${HEAD_REF} (merging ${BASE_REF} into it)

A merge of the base branch (origin/${BASE_REF}) has been started but has
conflicts in the following files:
${CONFLICTED_FILES}

The conflicted files contain standard git conflict markers
(<<<<<<< HEAD, =======, >>>>>>>).

Please resolve each conflict by:
1. Reading each conflicted file
2. Understanding the intent of both sides of the conflict
3. Editing the file to remove all conflict markers and produce the correct merged result
4. Staging the resolved files with `git add <file>`
5. Completing the merge with `git commit --no-edit`
