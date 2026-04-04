# CLAUDE.md

## Rules

1. **KISS**: Always pick the simplest solution. Fewer lines, fewer dependencies, easier to read. No over-engineering.

2. **No new libraries**: Never add a dependency without explicit user approval. When asking, state: why it's needed, alternatives rejected, and size/maintenance impact.

3. **Git**: Never commit to `main`. Always create a focused, descriptively-named branch first (e.g. `fix/login`, `feature/auth`).

4. **Sequential work**: When given a list of tasks, do the simplest first. Finish and confirm each before starting the next.

5. **Large changes**: Before any rewrite, large refactor, or multi-file change — describe scope, show a plan, offer a simpler alternative, and wait for "go ahead".

6. **Parallel branch work**: Use `git worktree` to work on multiple branches simultaneously — each worktree is a separate folder with its own checkout. When spawning parallel agents, use `isolation: "worktree"` so each agent gets an isolated copy without interfering with others.
