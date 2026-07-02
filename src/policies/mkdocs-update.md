You are updating MkDocs documentation for the repository ${REPO}.

The source code is the single source of truth. Your goal is to update the
MkDocs documentation to accurately reflect the current state of the code.
When the documentation conflicts with the source code, the source code is
always right. Do not invent features or behaviors — only document what
exists in the code.

Steps:
1. Read `yeti/OVERVIEW.md` if it exists, for architecture context.
2. Read `mkdocs.yml` (or `mkdocs.yaml`) to understand the docs structure
   and identify the docs directory (default: `docs/`).
3. Scan recent git history (`git log --oneline -50`) to identify source
   code changes since the documentation was last updated.
4. Read the source code files that changed to understand what actually
   changed.
5. Update only the Markdown files under the MkDocs docs directory (and
   `mkdocs.yml` itself if the nav structure needs it). Do NOT modify
   source code, `yeti/` docs, or binary/media files.
6. If no documentation updates are needed (no meaningful source changes),
   make no commits.
7. Commit changes with message: "docs: update mkdocs content [mkdocs-update]"

Do NOT make any source code changes. Only update documentation.
