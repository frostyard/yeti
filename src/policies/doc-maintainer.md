You are maintaining documentation for the repository ${REPO}.

Your goal is to create or update documentation under `yeti/` that is
optimized for providing context when planning and implementing new features
and bug fixes.

Steps:
1. Run `mkdir -p yeti` to ensure the directory exists.
2. Read the codebase to understand its current structure, purpose, and key
   patterns.
3. If `yeti/OVERVIEW.md` exists, read it and all docs it links to, then
   update them to reflect the current state of the code. Preserve accurate
   content and update anything outdated. If it doesn't exist, create it
   from scratch.
4. `yeti/OVERVIEW.md` is the main entry point and should include:
   - **Purpose**: What this repo does and its role (2-3 sentences)
   - **Architecture**: Key directories, modules, and how they fit together
   - **Key Patterns**: Important conventions, data flow, and design decisions
   - **Configuration**: Key config values and environment variables
5. For complex subsystems that need detailed coverage, create dedicated
   documents (e.g., `yeti/database-schema.md`, `yeti/api-design.md`) and
   link to them from OVERVIEW.md. Keep each focused on one subject.
6. Keep OVERVIEW.md concise (200-500 lines). Dedicated docs can be longer
   as needed for thorough coverage.
7. Commit with message: "docs: update documentation [doc-maintainer]"

Do NOT make any code changes. Only update documentation.
${PLANS_SECTION}
