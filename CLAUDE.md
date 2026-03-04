# github-issue-collab — Claude Instructions

## Repo overview

Full-stack app (Next.js + Hono API) that lets teams collaborate on GitHub issues via shared workspaces.

- `apps/web/` — Next.js frontend
- `apps/server/` — Hono API server (implement features here)
- `packages/` — shared types/utils

## Builder automation

The repo uses an autonomous builder loop (`scripts/builder-loop.sh`) that:
1. Reads a GitHub discussion thread (issue #3) for product ideas
2. Files concrete GitHub issues
3. Creates git worktrees under `.claude/worktrees/issue-<N>/`
4. Launches Claude instances in `github-builder` tmux session to implement each issue
5. Monitors those windows — nudges idle Claude, relaunches crashed Claude, cleans up closed issues

### Running the builder

```bash
# Copy to /tmp and run in tmux window 5 of github-proj-leads-discussion
cp scripts/builder-loop.sh /tmp/builder-loop.sh
tmux send-keys -t github-proj-leads-discussion:5 "bash /tmp/builder-loop.sh" Enter
```

The script is kept in `/tmp/` while running so edits during a session don't require a restart — just edit `/tmp/builder-loop.sh` directly, then copy back to `scripts/` and commit.

### Key config in builder-loop.sh

| Variable | Value |
|---|---|
| `REPO` | `vyshnavsdeepak/github-issue-collab` |
| `DISCUSSION_ISSUE` | `3` |
| `BUILDER_SESSION` | `github-builder` |
| `REPO_ROOT` | `/Users/vyshnav/src/github.com/vyshnavsdeepak/github-issue-collab` |
| `SLEEP` | `300` (scan every 5 min) |

### Window state detection (monitor_builder_windows)

| Pane content | State | Action |
|---|---|---|
| `bypass permissions on` + no PR | `claude_repl` (idle) | Nudge with PR prompt |
| `bypass permissions on` + PR exists | done | Skip |
| `vyshnav@` or `>>` + no PR | `shell` (crashed) | Relaunch Claude |
| Shell prompt + PR exists | done | Skip |
| Spinner words (`Crunching`, `Brewing`, etc.) | `active` | Skip |

### Rate limit / backoff

- `set_backoff` writes an expiry timestamp to `/tmp/rl-backoff-until.txt`
- Also touches `/tmp/rl-resumed.txt` to trigger `resume_after_backoff` once the backoff clears
- After backoff clears, `resume_after_backoff` sends `"continue with the task"` to idle Claude windows

### Editing the builder loop

To update the script and keep `/tmp/` in sync:
```bash
# Edit in repo
vim scripts/builder-loop.sh
# Sync to running location
cp scripts/builder-loop.sh /tmp/builder-loop.sh
# The running loop picks up changes on next iteration (it re-reads functions each loop)
# Actually: you need to restart the tmux process for changes to take effect
```

## Development

```bash
# Install deps
pnpm install

# Start dev servers
pnpm dev

# Database (requires POSTGRES_URL in apps/server/.env)
pnpm db:push
```

## Commit style

- Short imperative subject line
- No `Co-Authored-By` trailers
- Reference issue numbers in PR body (e.g. `Closes #42`)
