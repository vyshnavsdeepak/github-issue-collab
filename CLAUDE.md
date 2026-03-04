# github-issue-collab — Claude Instructions

## Repo overview

Full-stack app (Next.js + Hono API) that lets teams collaborate on GitHub issues via shared workspaces.

- `apps/web/` — Next.js frontend
- `apps/server/` — Hono API server (implement features here)
- `packages/` — shared types/utils

## Builder automation

The builder is a Rust TUI (`tools/builder-tui/`) that runs the full autonomous loop:

1. Reads GitHub discussion issue #3 for product ideas
2. Files concrete GitHub issues
3. Creates git worktrees under `.claude/worktrees/issue-<N>/`
4. Launches Claude instances in `github-builder` tmux session to implement each issue
5. Monitors worker windows — nudges idle Claude, relaunches crashed Claude

### Running the builder

```bash
cd tools/builder-tui
cargo build --release
./target/release/builder-tui
```

Run it in the `vyshnav-builder` window of the `github-proj-leads-discussion` tmux session.

Key bindings: `j/k` scroll · `s` send prompt to selected worker · `i` interrupt (C-c) · `b` broadcast to all idle workers · `r` force refresh · `q` quit

### Key config (`tools/builder-tui/src/config.rs`)

| Field | Value |
|---|---|
| `repo` | `vyshnavsdeepak/github-issue-collab` |
| `discussion_issue` | `3` |
| `builder_session` | `github-builder` |
| `repo_root` | `/Users/vyshnav/src/github.com/vyshnavsdeepak/github-issue-collab` |
| `scan_interval` | `300s` |

### Rate limit / backoff

- Backoff expiry stored in `/tmp/rl-backoff-until.txt`
- After backoff clears, TUI sends `"continue with the task"` to idle workers

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
