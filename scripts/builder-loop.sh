#!/bin/bash
# Vyshnav Builder — reads discussion, files issues, spins up worktrees + Claude tabs
REPO="vyshnavsdeepak/github-issue-collab"
REPO_ROOT="/Users/vyshnav/src/github.com/vyshnavsdeepak/github-issue-collab"
DISCUSSION_ISSUE=3
BUILDER_SESSION="github-builder"
SLEEP=300

RL_FLAG="/tmp/rl-backoff-until.txt"

in_backoff() {
  [ -f "$RL_FLAG" ] || return 1
  local until=$(cat "$RL_FLAG")
  [ "$(date +%s)" -lt "$until" ] && return 0 || return 1
}

parse_retry_after() {
  local text="$1"
  local secs=$(echo "$text" | grep -oi "try again in [0-9]* second" | grep -o '[0-9]*' | head -1)
  local mins=$(echo "$text" | grep -oi "try again in [0-9]* minute" | grep -o '[0-9]*' | head -1)
  if [ -n "$secs" ]; then echo "$secs"; return; fi
  if [ -n "$mins" ]; then echo $((mins * 60)); return; fi
  echo 120
}

set_backoff() {
  local wait="$1"
  local until=$(( $(date +%s) + wait + 30 ))
  echo "$until" > "$RL_FLAG"
  touch /tmp/rl-resumed.txt  # mark that resume is needed after backoff clears
  echo "[$(date +%H:%M:%S)] Rate limit hit — backing off ${wait}s (all loops paused)"
}

is_rate_limited() {
  echo "$1" | grep -qi "rate.limit\|429\|too many requests\|try again in\|overloaded\|API error" && return 0
  return 1
}

write_builder_status() {
  local session="github-builder"
  local windows
  windows=$(/opt/homebrew/bin/tmux list-windows -t "$session" -F "#{window_index}:#{window_name}" 2>/dev/null)
  local json='{"prs":{'
  local first=1
  while IFS=: read -r idx name; do
    [[ "$name" == "zsh" ]] && continue
    local issue_num
    issue_num=$(echo "$name" | grep -o '[0-9]*$')
    [ -z "$issue_num" ] && continue
    local pr_num
    pr_num=$(gh pr list --repo "$REPO" --state all --json number,body \
      -q ".[] | select(.body | test(\"#${issue_num}\")) | .number" 2>/dev/null | head -1)
    if [ -n "$pr_num" ]; then
      [ "$first" -eq 0 ] && json="$json,"
      json="$json\"$name\":\"#$pr_num\""
      first=0
    fi
  done <<< "$windows"
  json="$json}}"
  echo "$json" > /tmp/builder-status.json
}

monitor_builder_windows() {
  local session="github-builder"
  local windows
  windows=$(/opt/homebrew/bin/tmux list-windows -t "$session" -F "#{window_index}:#{window_name}" 2>/dev/null)
  [ -z "$windows" ] && return

  while IFS=: read -r idx name; do
    [[ "$name" == "zsh" ]] && continue

    local issue_num
    issue_num=$(echo "$name" | grep -o '[0-9]*$')
    [ -z "$issue_num" ] && continue

    local pane_text
    pane_text=$(/opt/homebrew/bin/tmux capture-pane -t "$session:$idx" -p 2>/dev/null | tail -20)

    local state="unknown"
    if echo "$pane_text" | grep -q "bypass permissions on"; then
      state="claude_repl"
    elif echo "$pane_text" | grep -qE "^(vyshnav@|>>)"; then
      state="shell"
    elif echo "$pane_text" | grep -qi "spinner\|thinking\|Crunching\|Brewing\|Baking\|Cogitating"; then
      state="active"
    fi

    [ "$state" = "active" ] && continue

    local pr_exists
    pr_exists=$(gh pr list --repo "$REPO" --state all --json number,body \
      -q ".[] | select(.body | test(\"#${issue_num}\")) | .number" 2>/dev/null | head -1)

    if [ "$state" = "claude_repl" ] && [ -z "$pr_exists" ]; then
      echo "[monitor] Issue #$issue_num: Claude idle, no PR found — nudging"
      /opt/homebrew/bin/tmux send-keys -t "$session:$idx" \
        "Have you pushed the branch and opened a PR to main referencing #${issue_num}? If not, please do that now." Enter
      gh issue comment $DISCUSSION_ISSUE --repo $REPO --body \
"🔧 **Vyshnav (Builder):** Nudged Claude on issue #${issue_num} — was idle without a PR.

**— Vyshnav (simulated builder)**" 2>/dev/null

    elif [ "$state" = "shell" ] && [ -z "$pr_exists" ]; then
      echo "[monitor] Issue #$issue_num: Claude exited, no PR — relaunching"
      local branch="feature/issue-$issue_num"
      local worktree="$REPO_ROOT/.claude/worktrees/issue-$issue_num"
      [ ! -d "$worktree" ] && continue

      CLAUDE_PROMPT="Implement GitHub issue #$issue_num in this repo. Push branch $branch and open a PR to main referencing #$issue_num. Work autonomously."
      /opt/homebrew/bin/tmux send-keys -t "$session:$idx" \
        "cd '$worktree' && claude --dangerously-skip-permissions '$CLAUDE_PROMPT'" Enter

      gh issue comment $DISCUSSION_ISSUE --repo $REPO --body \
"🔄 **Vyshnav (Builder):** Relaunched Claude on issue #${issue_num} — previous run exited without a PR.

**— Vyshnav (simulated builder)**" 2>/dev/null
    fi
    sleep 2
  done <<< "$windows"
}

cleanup_finished_windows() {
  local session="github-builder"
  local windows
  windows=$(/opt/homebrew/bin/tmux list-windows -t "$session" -F "#{window_index}:#{window_name}" 2>/dev/null)
  [ -z "$windows" ] && return

  while IFS=: read -r idx name; do
    [[ "$name" == "zsh" ]] && continue
    local issue_num
    issue_num=$(echo "$name" | grep -o '[0-9]*$')
    [ -z "$issue_num" ] && continue

    local issue_state
    issue_state=$(gh issue view "$issue_num" --repo "$REPO" --json state -q '.state' 2>/dev/null)
    [ "$issue_state" != "CLOSED" ] && continue

    echo "[cleanup] Issue #$issue_num closed — removing window $idx and worktree"
    local worktree="$REPO_ROOT/.claude/worktrees/issue-$issue_num"
    if [ -d "$worktree" ]; then
      git -C "$REPO_ROOT" worktree remove --force "$worktree" 2>/dev/null
    fi
    /opt/homebrew/bin/tmux kill-window -t "$session:$idx" 2>/dev/null
    sleep 1
  done <<< "$windows"
}

REBASE_CHECK_FILE="/tmp/builder-last-merge-check.txt"

notify_workers_to_rebase() {
  # Get timestamp of last check (default: 10 minutes ago)
  local last_check
  if [ -f "$REBASE_CHECK_FILE" ]; then
    last_check=$(cat "$REBASE_CHECK_FILE")
  else
    last_check=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u --date="10 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "$REBASE_CHECK_FILE"

  # Check for PRs merged since last check
  local merged_prs
  merged_prs=$(gh pr list --repo "$REPO" --state merged --json number,title,mergedAt \
    -q ".[] | select(.mergedAt > \"$last_check\") | \"#\(.number) \(.title)\"" 2>/dev/null)
  [ -z "$merged_prs" ] && return

  echo "[rebase] Detected merged PRs since $last_check:"
  echo "$merged_prs"

  # Pull latest main into REPO_ROOT
  git -C "$REPO_ROOT" fetch origin main --quiet 2>/dev/null

  local session="github-builder"
  local windows
  windows=$(/opt/homebrew/bin/tmux list-windows -t "$session" -F "#{window_index}:#{window_name}" 2>/dev/null)
  [ -z "$windows" ] && return

  while IFS=: read -r idx name; do
    [[ "$name" == "zsh" ]] && continue
    local issue_num
    issue_num=$(echo "$name" | grep -o '[0-9]*$')
    [ -z "$issue_num" ] && continue

    local pane_text
    pane_text=$(/opt/homebrew/bin/tmux capture-pane -t "$session:$idx" -p 2>/dev/null | tail -10)

    if echo "$pane_text" | grep -q "bypass permissions on"; then
      # Claude is at REPL — ask it to rebase
      echo "[rebase] Asking issue #$issue_num worker to rebase on latest main"
      /opt/homebrew/bin/tmux send-keys -t "$session:$idx" \
        "Some PRs just merged to main. Please run: git fetch origin && git rebase origin/main — then continue your work." Enter
      sleep 1
    elif echo "$pane_text" | grep -qE "^(vyshnav@|>>)"; then
      # At shell — do the rebase directly
      local worktree="$REPO_ROOT/.claude/worktrees/issue-$issue_num"
      [ ! -d "$worktree" ] && continue
      echo "[rebase] Running rebase for issue #$issue_num at shell"
      /opt/homebrew/bin/tmux send-keys -t "$session:$idx" \
        "cd '$worktree' && git fetch origin && git rebase origin/main && echo '[rebase done]'" Enter
      sleep 1
    fi
    # skip active (spinner) windows — Claude will handle it when it pauses
  done <<< "$windows"
}

resume_after_backoff() {
  [ -f "$RL_FLAG" ] && return
  [ ! -f "/tmp/rl-resumed.txt" ] && return
  rm -f /tmp/rl-resumed.txt

  local session="github-builder"
  local windows
  windows=$(/opt/homebrew/bin/tmux list-windows -t "$session" -F "#{window_index}:#{window_name}" 2>/dev/null)
  [ -z "$windows" ] && return

  echo "[builder] Backoff cleared — sending 'continue' to active Claude windows"
  while IFS=: read -r idx name; do
    [[ "$name" == "zsh" ]] && continue
    local pane_text
    pane_text=$(/opt/homebrew/bin/tmux capture-pane -t "$session:$idx" -p 2>/dev/null | tail -10)
    if echo "$pane_text" | grep -q "bypass permissions on"; then
      /opt/homebrew/bin/tmux send-keys -t "$session:$idx" "continue with the task" Enter
      sleep 1
    fi
  done <<< "$windows"
}

echo "[builder] Starting Vyshnav Builder loop..."

while true; do
  if in_backoff; then
    echo "[$(date +%H:%M:%S)] builder: in backoff, sleeping 30s..."
    sleep 30
    continue
  fi

  resume_after_backoff

  echo "[builder] Reading discussion and existing issues..."

  DISCUSSION=$(gh issue view $DISCUSSION_ISSUE --repo $REPO --comments \
    --json title,body,comments \
    -q '"=== DISCUSSION ===\nTitle: " + .title + "\n\n" + .body + "\n\n=== COMMENTS ===\n" + (.comments | map(.author.login + ": " + .body) | join("\n---\n"))')

  EXISTING_ISSUES=$(gh issue list --repo $REPO --state open --json number,title \
    -q '.[] | "#\(.number): \(.title)"')

  PROMPT='You are Vyshnav, a pragmatic builder. Read this product discussion and extract 1-2 concrete implementable tasks not already filed.

'"$DISCUSSION"'

EXISTING OPEN ISSUES (do not duplicate):
'"$EXISTING_ISSUES"'

Rules:
- Only output tasks that are concrete and implementable in code
- Skip anything vague or already covered by existing issues
- If nothing new and concrete, output exactly: NONE

For each task output one JSON per line (no other text):
{"title": "Short imperative title", "body": "Detailed spec of what to implement and why"}

Output ONLY json lines or NONE.'

  TASKS=$(claude --dangerously-skip-permissions --print "$PROMPT" 2>/dev/null)
  RC=$?
  echo "[builder] Claude returned: $TASKS"

  if [ $RC -ne 0 ] || is_rate_limited "$TASKS"; then
    WAIT=$(parse_retry_after "$TASKS")
    set_backoff "$WAIT"
    sleep 30
    continue
  fi

  if [ "$TASKS" = "NONE" ] || [ -z "$TASKS" ]; then
    echo "[builder] No new tasks. Sleeping ${SLEEP}s..."
    sleep $SLEEP
    continue
  fi

  CREATED=0
  while IFS= read -r task_line; do
    [[ -z "$task_line" || "$task_line" == NONE ]] && continue
    # Validate JSON
    echo "$task_line" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null || continue

    TITLE=$(echo "$task_line" | python3 -c "import sys,json; print(json.load(sys.stdin)['title'])")
    BODY=$(echo "$task_line" | python3 -c "import sys,json; print(json.load(sys.stdin)['body'])")
    [ -z "$TITLE" ] && continue

    echo "[builder] Creating issue: $TITLE"
    ISSUE_URL=$(gh issue create --repo $REPO --title "$TITLE" --body "$BODY" 2>/dev/null)
    ISSUE_NUM=$(echo "$ISSUE_URL" | grep -o '[0-9]*$')
    [ -z "$ISSUE_NUM" ] && continue

    echo "[builder] Created issue #$ISSUE_NUM"

    # Comment on discussion thread
    gh issue comment $DISCUSSION_ISSUE --repo $REPO --body \
"🔨 **Vyshnav (Builder):** Picked this up → created #$ISSUE_NUM: **$TITLE**. Spinning up a worktree now.

**— Vyshnav (simulated builder)**" 2>/dev/null

    # Create worktree
    BRANCH="feature/issue-$ISSUE_NUM"
    WORKTREE="$REPO_ROOT/.claude/worktrees/issue-$ISSUE_NUM"

    if [ -d "$WORKTREE" ]; then
      echo "[builder] Worktree $WORKTREE already exists, skipping."
      CREATED=$((CREATED + 1))
      break
    fi

    git -C "$REPO_ROOT" worktree add "$WORKTREE" -b "$BRANCH" 2>&1
    echo "[builder] Worktree created at $WORKTREE"

    # Ensure github-builder session exists
    /opt/homebrew/bin/tmux new-session -d -s $BUILDER_SESSION 2>/dev/null || true

    WINDOW="issue-$ISSUE_NUM"
    /opt/homebrew/bin/tmux new-window -t $BUILDER_SESSION -n "$WINDOW" 2>/dev/null

    CLAUDE_PROMPT="Implement GitHub issue #$ISSUE_NUM in this repo.

Title: $TITLE

Spec:
$BODY

Instructions:
- Read the relevant source files first to understand the codebase
- Implement the feature in apps/server/src/
- Commit with a clear message (no Co-Authored-By)
- Push branch $BRANCH
- Open a PR to main referencing #$ISSUE_NUM in the PR body
- Work autonomously, do not ask for confirmation"

    /opt/homebrew/bin/tmux send-keys -t "$BUILDER_SESSION:$WINDOW" \
      "cd '$WORKTREE' && claude --dangerously-skip-permissions '$CLAUDE_PROMPT'" Enter

    echo "[builder] Launched Claude in $BUILDER_SESSION:$WINDOW for issue #$ISSUE_NUM"
    CREATED=$((CREATED + 1))
    break  # only create 1 issue per scan
  done <<< "$TASKS"

  echo "[builder] Writing builder status for TUI..."
  write_builder_status

  echo "[builder] Monitoring github-builder windows..."
  monitor_builder_windows

  echo "[builder] Checking for merged PRs and notifying workers to rebase..."
  notify_workers_to_rebase

  echo "[builder] Cleaning up finished windows..."
  cleanup_finished_windows

  echo "[builder] Sleeping ${SLEEP}s before next scan..."
  sleep $SLEEP
done
