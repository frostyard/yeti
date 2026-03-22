# Contributing

Yeti is a Frostyard project. Contributions are welcome --- whether that's fixing a bug, adding a job, improving documentation, or just reporting an issue.

---

## Development setup

**Prerequisites:**

- Node.js 22+
- `gh` CLI (authenticated)
- `claude` CLI (authenticated) --- needed to run integration-style tests manually

**Getting started:**

```bash
git clone https://github.com/frostyard/yeti.git
cd yeti
npm ci
npm run build
npm test
```

**Development mode:**

```bash
npm run dev
```

This runs the project with `tsx` for live TypeScript execution without a build step.

---

## Project structure

```
src/
├── main.ts              # Entry point, initialization, shutdown
├── scheduler.ts         # Job scheduling engine
├── claude.ts            # AI backend dispatch and worktree management
├── github.ts            # GitHub API via gh CLI
├── config.ts            # Configuration loading and live reload
├── db.ts                # SQLite database
├── server.ts            # HTTP dashboard
├── discord.ts           # Discord bot
├── notify.ts            # Notification dispatcher
├── error-reporter.ts    # Error deduplication and reporting
├── jobs/                # One file per job
│   ├── issue-refiner.ts
│   ├── plan-reviewer.ts
│   ├── issue-worker.ts
│   ├── ci-fixer.ts
│   ├── auto-merger.ts
│   ├── review-addresser.ts
│   ├── doc-maintainer.ts
│   ├── improvement-identifier.ts
│   ├── issue-auditor.ts
│   ├── repo-standards.ts
│   └── triage-yeti-errors.ts
├── pages/               # Dashboard HTML builders
└── test-helpers.ts      # Test factories
```

---

## Testing

Tests are co-located with source files (`*.test.ts` next to the module they test). Run them with:

```bash
npm test                                    # all tests
npx vitest run src/scheduler.test.ts        # single file
npx vitest run -t "returns ms until"        # by name pattern
npm run test:watch                          # watch mode
```

**Testing conventions:**

- External boundaries are mocked: `gh` CLI, `claude` CLI, filesystem operations.
- Use `vi.mock()` at module level for mocking.
- Test helpers in `src/test-helpers.ts` provide factories: `mockRepo()`, `mockIssue()`, `mockPR()`.
- TDD is the expected workflow --- write a failing test, then implement.

---

## Making changes

1. **Create a branch** from `main`:

    ```bash
    git checkout -b feat/your-feature
    ```

2. **Write tests first** --- Yeti uses TDD. Start with a failing test that describes the behavior you want.

3. **Implement the change** --- make the test pass.

4. **Check everything builds:**

    ```bash
    npm run build
    npm test
    ```

5. **Consider cross-cutting concerns:**
    - Changes to `src/config.ts`? Update `deploy/install.sh` and `src/pages/config.ts`.
    - Changes to job behavior? Update `src/pages/dashboard.ts` and `src/pages/queue.ts`.
    - New API routes? Update `src/pages/` accordingly.
    - New or changed config fields? Add form controls in `src/pages/config.ts`.

6. **Update documentation** --- update `CLAUDE.md`, `README.md`, and relevant files in `yeti/` and `site/`.

---

## Adding a new job

Jobs follow a consistent pattern. Each job:

1. Exports a `run()` function
2. Is registered in `main.ts`
3. Must be listed in `enabledJobs` to activate

**Steps to add a job:**

1. Create `src/jobs/your-job.ts` with a `run()` export.
2. Create `src/jobs/your-job.test.ts` with tests.
3. Register the job in `src/main.ts` with the scheduler.
4. Add the interval/schedule config to `src/config.ts`.
5. Add the job name to the type definitions.
6. Update the dashboard pages if the job introduces new queue categories or states.
7. Add documentation in `site/reference/jobs/your-job.md` and update `site/reference/jobs/index.md`.
8. Update `mkdocs.yml` nav to include the new job page.

---

## Commit conventions

Yeti uses conventional commits:

```
feat: add new capability
fix: resolve a bug
refactor: restructure without behavior change
docs: documentation only
test: test additions or changes
chore: build, CI, or tooling changes
```

Keep commit messages concise. The PR description is where detail belongs.

---

## Release process

Releases are automatic. When changes land on `main`:

1. The release workflow creates a version tag: `v<YYYY-MM-DD>.<N>`
2. A release tarball is built: `dist/` + `deploy/` + `node_modules/`
3. The tarball is published as a GitHub release
4. Deployed instances pick up the release via the auto-updater within 60 seconds

---

## Code style

- **TypeScript** with strict mode enabled
- **ESM** modules (`"type": "module"` in package.json)
- No default exports
- Prefer `const` over `let`, never `var`
- Error handling at boundaries, not defensively everywhere
- Keep files focused --- if a file is growing past a few hundred lines, consider splitting

---

## Reporting issues

Found a bug or have a feature idea? Open an issue on the [GitHub repository](https://github.com/frostyard/yeti/issues).

For bug reports, include:

- What you expected to happen
- What actually happened
- Relevant log output (`journalctl -u yeti -n 100 --no-pager`)
- Your Yeti version (`curl localhost:9384/status | jq .version`)
- Your `enabledJobs` configuration
