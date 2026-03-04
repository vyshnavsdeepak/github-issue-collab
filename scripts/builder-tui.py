#!/usr/bin/env python3
"""
Vyshnav Builder TUI — Python + Textual dashboard for the builder loop.
Replaces builder-loop.sh for interactive use.

Setup:
    pip3 install textual rich

Run:
    python3 scripts/builder-tui.py
"""

import asyncio
import json
import re
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, ScrollableContainer, Horizontal
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Footer, Header, RichLog, Static
from rich.text import Text
from rich.panel import Panel
from rich.table import Table

# ── Config ────────────────────────────────────────────────────────────────────

REPO = "vyshnavsdeepak/github-issue-collab"
REPO_ROOT = "/Users/vyshnav/src/github.com/vyshnavsdeepak/github-issue-collab"
DISCUSSION_ISSUE = 3
BUILDER_SESSION = "github-builder"
SCAN_INTERVAL = 300       # seconds between full scans
MONITOR_INTERVAL = 15     # seconds between worker refreshes
TMUX = "/opt/homebrew/bin/tmux"

RL_FLAG = Path("/tmp/rl-backoff-until.txt")
RL_RESUMED = Path("/tmp/rl-resumed.txt")
REBASE_CHECK_FILE = Path("/tmp/builder-last-merge-check.txt")
LOG_MAX_LINES = 500

# ── Data ──────────────────────────────────────────────────────────────────────

@dataclass
class WorkerState:
    issue_num: int
    window_idx: str
    state: str = "unknown"   # active | idle | shell | unknown | done
    pr_number: Optional[int] = None
    pr_merged: bool = False
    last_seen: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_pane: str = ""

# ── Async subprocess helpers ──────────────────────────────────────────────────

async def run(*cmd, input: Optional[str] = None) -> tuple[int, str, str]:
    """Run a command asynchronously, return (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE if input else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdin_bytes = input.encode() if input else None
    stdout, stderr = await proc.communicate(stdin_bytes)
    return proc.returncode, stdout.decode().strip(), stderr.decode().strip()


async def gh(*args) -> tuple[int, str]:
    rc, out, _ = await run("gh", *args)
    return rc, out


async def tmux(*args) -> tuple[int, str]:
    rc, out, _ = await run(TMUX, *args)
    return rc, out

# ── Rate limit helpers ────────────────────────────────────────────────────────

def in_backoff() -> bool:
    if not RL_FLAG.exists():
        return False
    try:
        until = int(RL_FLAG.read_text().strip())
        return time.time() < until
    except Exception:
        return False


def backoff_remaining() -> int:
    """Seconds remaining in backoff, 0 if not in backoff."""
    if not RL_FLAG.exists():
        return 0
    try:
        until = int(RL_FLAG.read_text().strip())
        remaining = int(until - time.time())
        return max(0, remaining)
    except Exception:
        return 0


def set_backoff(wait: int) -> None:
    until = int(time.time()) + wait + 30
    RL_FLAG.write_text(str(until))
    RL_RESUMED.touch()


def parse_retry_after(text: str) -> int:
    m = re.search(r"try again in (\d+) second", text, re.IGNORECASE)
    if m:
        return int(m.group(1))
    m = re.search(r"try again in (\d+) minute", text, re.IGNORECASE)
    if m:
        return int(m.group(1)) * 60
    return 120


def is_rate_limited(text: str) -> bool:
    return bool(re.search(r"rate.limit|429|too many requests|try again in|overloaded|API error", text, re.IGNORECASE))

# ── Worker detection helpers ──────────────────────────────────────────────────

def detect_state(pane_text: str) -> str:
    if "bypass permissions on" in pane_text:
        return "idle"  # Claude REPL waiting
    if re.search(r"^(vyshnav@|>>)", pane_text, re.MULTILINE):
        return "shell"
    if re.search(r"spinner|thinking|Crunching|Brewing|Baking|Cogitating", pane_text, re.IGNORECASE):
        return "active"
    return "unknown"

# ── Widgets ───────────────────────────────────────────────────────────────────

STATE_COLORS = {
    "active":  "green",
    "idle":    "yellow",
    "shell":   "red",
    "unknown": "white dim",
    "done":    "blue",
}

STATE_ICONS = {
    "active":  "●",
    "idle":    "◉",
    "shell":   "✗",
    "unknown": "?",
    "done":    "✓",
}


class WorkerCard(Static):
    """Displays one worker's status."""

    DEFAULT_CSS = """
    WorkerCard {
        width: 26;
        height: 7;
        margin: 0 1 1 0;
        border: round $primary-darken-3;
        padding: 0 1;
    }
    """

    def __init__(self, worker: WorkerState, **kwargs):
        super().__init__(**kwargs)
        self._worker = worker

    def update_worker(self, worker: WorkerState) -> None:
        self._worker = worker
        self.refresh()

    def render(self) -> Text:
        w = self._worker
        color = STATE_COLORS.get(w.state, "white")
        icon = STATE_ICONS.get(w.state, "?")

        now = datetime.now(timezone.utc)
        age_secs = int((now - w.last_seen).total_seconds())
        if age_secs < 60:
            age_str = f"{age_secs}s ago"
        else:
            age_str = f"{age_secs // 60}m ago"

        if w.pr_number:
            pr_info = f"PR #{w.pr_number}" + (" merged" if w.pr_merged else " open")
        else:
            pr_info = "No PR"

        t = Text()
        t.append(f"#{w.issue_num}\n", style="bold")
        t.append(f"{icon} {w.state.upper()}\n", style=color)
        t.append(f"{pr_info}\n", style="dim")
        t.append(age_str, style="dim")
        return t


class StatusBar(Static):
    """Top status bar."""

    DEFAULT_CSS = """
    StatusBar {
        height: 3;
        background: $surface;
        border: hline $primary-darken-3;
        padding: 0 2;
        content-align: left middle;
    }
    """

    running: reactive[bool] = reactive(True)
    next_scan_in: reactive[int] = reactive(SCAN_INTERVAL)
    worker_counts: reactive[dict] = reactive({})

    def render(self) -> Text:
        t = Text()
        status_color = "green" if self.running else "red"
        status_label = "RUNNING" if self.running else "STOPPED"
        t.append(f"● {status_label}", style=f"bold {status_color}")
        t.append("  │  ", style="dim")

        secs = self.next_scan_in
        t.append(f"Next scan: {secs // 60}m {secs % 60:02d}s", style="cyan")
        t.append("  │  ", style="dim")

        backoff = backoff_remaining()
        if backoff > 0:
            t.append(f"BACKOFF {backoff // 60}m {backoff % 60:02d}s", style="bold red")
        else:
            t.append("Rate limit: OK", style="green")

        counts = self.worker_counts or {}
        active = counts.get("active", 0)
        idle = counts.get("idle", 0)
        shell = counts.get("shell", 0)
        unknown = counts.get("unknown", 0)
        t.append("  │  ", style="dim")
        t.append(f"{active} active", style="green")
        t.append(" · ", style="dim")
        t.append(f"{idle} idle", style="yellow")
        t.append(" · ", style="dim")
        t.append(f"{shell} crashed", style="red")
        if unknown:
            t.append(f" · {unknown} unknown", style="dim")

        t.append(f"  │  {datetime.now().strftime('%H:%M:%S')}", style="dim")
        return t


class WorkerGrid(ScrollableContainer):
    """Scrollable grid of WorkerCards."""

    DEFAULT_CSS = """
    WorkerGrid {
        height: 1fr;
        border: round $primary-darken-2;
        padding: 1;
        layout: horizontal;
        flex-wrap: wrap;
        overflow-y: auto;
    }
    """

# ── Main App ──────────────────────────────────────────────────────────────────

class BuilderApp(App):
    """Vyshnav Builder TUI."""

    CSS = """
    Screen {
        layout: vertical;
    }
    #header-bar {
        height: 1;
        background: $primary-darken-2;
        color: $text;
        content-align: center middle;
        text-style: bold;
    }
    #status-bar {
        height: 1;
        padding: 0 2;
        background: $surface-darken-1;
    }
    #workers-label {
        height: 1;
        background: $primary-darken-3;
        padding: 0 2;
        color: $text-muted;
    }
    WorkerGrid {
        height: 12;
        min-height: 8;
    }
    #log-label {
        height: 1;
        background: $primary-darken-3;
        padding: 0 2;
        color: $text-muted;
    }
    #activity-log {
        height: 1fr;
        border: round $primary-darken-2;
        padding: 0 1;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("r", "rebase_check", "Rebase check"),
        Binding("s", "force_scan", "Force scan"),
        Binding("f", "focus_worker", "Focus worker"),
    ]

    def __init__(self):
        super().__init__()
        self._workers: dict[int, WorkerState] = {}
        self._cards: dict[int, WorkerCard] = {}
        self._scan_countdown = SCAN_INTERVAL
        self._force_scan = False
        self._force_rebase = False

    def compose(self) -> ComposeResult:
        yield Static(
            f"🔨 Vyshnav Builder  ─  {REPO}",
            id="header-bar",
        )
        yield StatusBar(id="status-bar")
        yield Static("WORKERS  (scrollable)", id="workers-label")
        yield WorkerGrid(id="worker-grid")
        yield Static("ACTIVITY LOG  (scrollable)", id="log-label")
        yield RichLog(id="activity-log", highlight=True, markup=True, max_lines=LOG_MAX_LINES)
        yield Footer()

    def on_mount(self) -> None:
        self.set_interval(1, self._tick_countdown)
        self.set_interval(MONITOR_INTERVAL, self._refresh_workers)
        self.set_interval(SCAN_INTERVAL, self._run_scan_cycle)
        # Kick off initial worker refresh immediately
        self.call_after_refresh(self._refresh_workers)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def log_activity(self, category: str, message: str) -> None:
        log: RichLog = self.query_one("#activity-log", RichLog)
        ts = datetime.now().strftime("%H:%M:%S")
        cat_colors = {
            "monitor": "cyan",
            "rebase":  "yellow",
            "builder": "green",
            "cleanup": "magenta",
            "error":   "red",
            "info":    "white dim",
        }
        cat_color = cat_colors.get(category, "white")
        log.write(Text.assemble(
            (f"  {ts}  ", "dim"),
            (f"{category:<8}", cat_color),
            f" {message}",
        ))

    def _update_status_bar(self) -> None:
        bar: StatusBar = self.query_one("#status-bar", StatusBar)
        bar.next_scan_in = self._scan_countdown
        counts: dict[str, int] = {}
        for w in self._workers.values():
            counts[w.state] = counts.get(w.state, 0) + 1
        bar.worker_counts = counts

    # ── Timers ────────────────────────────────────────────────────────────────

    def _tick_countdown(self) -> None:
        self._scan_countdown = max(0, self._scan_countdown - 1)
        self._update_status_bar()

    async def _refresh_workers(self) -> None:
        asyncio.create_task(self._do_refresh_workers())

    async def _run_scan_cycle(self) -> None:
        self._scan_countdown = SCAN_INTERVAL
        asyncio.create_task(self._do_scan_cycle())

    # ── Worker refresh ────────────────────────────────────────────────────────

    async def _do_refresh_workers(self) -> None:
        rc, out = await tmux("list-windows", "-t", BUILDER_SESSION, "-F", "#{window_index}:#{window_name}")
        if rc != 0 or not out:
            return

        lines = [l for l in out.splitlines() if l.strip()]
        new_states: dict[int, WorkerState] = {}

        for line in lines:
            parts = line.split(":", 1)
            if len(parts) != 2:
                continue
            idx, name = parts
            if name == "zsh":
                continue
            m = re.search(r"(\d+)$", name)
            if not m:
                continue
            issue_num = int(m.group(1))

            rc2, pane = await tmux("capture-pane", "-t", f"{BUILDER_SESSION}:{idx}", "-p")
            pane_tail = "\n".join(pane.splitlines()[-20:])
            state = detect_state(pane_tail)

            # Check PR
            existing = self._workers.get(issue_num)
            pr_number = existing.pr_number if existing else None
            pr_merged = existing.pr_merged if existing else False

            # Only re-query PR if we don't have one yet or state changed
            if pr_number is None or (existing and existing.state != state):
                rc3, pr_out = await gh(
                    "pr", "list", "--repo", REPO, "--state", "all",
                    "--json", "number,body,state",
                    "-q", f'.[] | select(.body | test("#{issue_num}")) | "\(.number) \(.state)"',
                )
                if pr_out:
                    first = pr_out.splitlines()[0].split()
                    if first:
                        pr_number = int(first[0])
                        pr_merged = (first[1].upper() == "MERGED") if len(first) > 1 else False

            worker = WorkerState(
                issue_num=issue_num,
                window_idx=idx,
                state=state,
                pr_number=pr_number,
                pr_merged=pr_merged,
                last_seen=datetime.now(timezone.utc),
                last_pane=pane_tail,
            )
            new_states[issue_num] = worker

        self._workers = new_states
        self._update_worker_grid()
        self._update_status_bar()

    def _update_worker_grid(self) -> None:
        grid: WorkerGrid = self.query_one("#worker-grid", WorkerGrid)

        # Remove cards for workers that no longer exist
        for issue_num in list(self._cards.keys()):
            if issue_num not in self._workers:
                try:
                    self._cards[issue_num].remove()
                except Exception:
                    pass
                del self._cards[issue_num]

        # Add or update cards
        for issue_num, worker in sorted(self._workers.items()):
            if issue_num in self._cards:
                self._cards[issue_num].update_worker(worker)
            else:
                card = WorkerCard(worker, id=f"worker-{issue_num}")
                self._cards[issue_num] = card
                grid.mount(card)

    # ── Scan cycle ────────────────────────────────────────────────────────────

    async def _do_scan_cycle(self) -> None:
        if in_backoff():
            remaining = backoff_remaining()
            self.log_activity("info", f"In backoff — {remaining}s remaining, skipping scan")
            return

        await self._resume_after_backoff()
        await self._monitor_workers()
        await self._notify_rebase()
        await self._cleanup_finished()
        await self._read_and_file_issues()

    async def _monitor_workers(self) -> None:
        for issue_num, worker in list(self._workers.items()):
            if worker.state == "active":
                continue

            if worker.state == "idle" and not worker.pr_number:
                self.log_activity("monitor", f"Issue #{issue_num} idle, no PR → nudging")
                await tmux(
                    "send-keys", "-t", f"{BUILDER_SESSION}:{worker.window_idx}",
                    f"Have you pushed the branch and opened a PR to main referencing #{issue_num}? If not, please do that now.",
                    "Enter",
                )
                await gh(
                    "issue", "comment", str(DISCUSSION_ISSUE), "--repo", REPO, "--body",
                    f"🔧 **Vyshnav (Builder):** Nudged Claude on issue #{issue_num} — was idle without a PR.\n\n**— Vyshnav (simulated builder)**",
                )
                await asyncio.sleep(2)

            elif worker.state == "shell" and not worker.pr_number:
                self.log_activity("monitor", f"Issue #{issue_num} crashed, no PR → relaunching")
                branch = f"feature/issue-{issue_num}"
                worktree = f"{REPO_ROOT}/.claude/worktrees/issue-{issue_num}"
                if not Path(worktree).is_dir():
                    continue

                prompt = f"Implement GitHub issue #{issue_num} in this repo. Push branch {branch} and open a PR to main referencing #{issue_num}. Work autonomously."
                await tmux(
                    "send-keys", "-t", f"{BUILDER_SESSION}:{worker.window_idx}",
                    f"cd '{worktree}' && claude --dangerously-skip-permissions '{prompt}'",
                    "Enter",
                )
                await gh(
                    "issue", "comment", str(DISCUSSION_ISSUE), "--repo", REPO, "--body",
                    f"🔄 **Vyshnav (Builder):** Relaunched Claude on issue #{issue_num} — previous run exited without a PR.\n\n**— Vyshnav (simulated builder)**",
                )
                await asyncio.sleep(2)

    async def _notify_rebase(self) -> None:
        if REBASE_CHECK_FILE.exists():
            last_check = REBASE_CHECK_FILE.read_text().strip()
        else:
            # Default: 10 minutes ago in ISO format
            from datetime import timedelta
            last_check = (datetime.now(timezone.utc) - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")

        REBASE_CHECK_FILE.write_text(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))

        rc, merged = await gh(
            "pr", "list", "--repo", REPO, "--state", "merged",
            "--json", "number,title,mergedAt",
            "-q", f'.[] | select(.mergedAt > "{last_check}") | "#\\(.number) \\(.title)"',
        )
        if not merged:
            self.log_activity("rebase", "No merged PRs since last check")
            return

        for line in merged.splitlines():
            self.log_activity("rebase", f"Merged: {line}")

        await run("git", "-C", REPO_ROOT, "fetch", "origin", "main", "--quiet")

        for issue_num, worker in list(self._workers.items()):
            if worker.state == "idle":
                await tmux(
                    "send-keys", "-t", f"{BUILDER_SESSION}:{worker.window_idx}",
                    "Some PRs just merged to main. Please run: git fetch origin && git rebase origin/main — then continue your work.",
                    "Enter",
                )
                self.log_activity("rebase", f"Asked issue #{issue_num} worker to rebase")
                await asyncio.sleep(1)
            elif worker.state == "shell":
                worktree = f"{REPO_ROOT}/.claude/worktrees/issue-{issue_num}"
                if not Path(worktree).is_dir():
                    continue
                await tmux(
                    "send-keys", "-t", f"{BUILDER_SESSION}:{worker.window_idx}",
                    f"cd '{worktree}' && git fetch origin && git rebase origin/main && echo '[rebase done]'",
                    "Enter",
                )
                self.log_activity("rebase", f"Running rebase for issue #{issue_num} at shell")
                await asyncio.sleep(1)

    async def _cleanup_finished(self) -> None:
        for issue_num, worker in list(self._workers.items()):
            rc, state_out = await gh(
                "issue", "view", str(issue_num), "--repo", REPO,
                "--json", "state", "-q", ".state",
            )
            if state_out != "CLOSED":
                continue

            self.log_activity("cleanup", f"Issue #{issue_num} closed — removing window and worktree")
            worktree = f"{REPO_ROOT}/.claude/worktrees/issue-{issue_num}"
            if Path(worktree).is_dir():
                await run("git", "-C", REPO_ROOT, "worktree", "remove", "--force", worktree)
            await tmux("kill-window", "-t", f"{BUILDER_SESSION}:{worker.window_idx}")
            await asyncio.sleep(1)

    async def _read_and_file_issues(self) -> None:
        self.log_activity("builder", "Reading discussion and existing issues...")

        rc, discussion_raw = await gh(
            "issue", "view", str(DISCUSSION_ISSUE), "--repo", REPO, "--comments",
            "--json", "title,body,comments",
            "-q",
            '"=== DISCUSSION ===\nTitle: " + .title + "\n\n" + .body + "\n\n=== COMMENTS ===\n" + (.comments | map(.author.login + ": " + .body) | join("\n---\n"))',
        )
        if rc != 0:
            self.log_activity("error", "Failed to read discussion")
            return

        rc2, existing_raw = await gh(
            "issue", "list", "--repo", REPO, "--state", "open",
            "--json", "number,title",
            "-q", '.[] | "#\\(.number): \\(.title)"',
        )

        prompt = f"""You are Vyshnav, a pragmatic builder. Read this product discussion and extract 1-2 concrete implementable tasks not already filed.

{discussion_raw}

EXISTING OPEN ISSUES (do not duplicate):
{existing_raw}

Rules:
- Only output tasks that are concrete and implementable in code
- Skip anything vague or already covered by existing issues
- If nothing new and concrete, output exactly: NONE

For each task output one JSON per line (no other text):
{{"title": "Short imperative title", "body": "Detailed spec of what to implement and why"}}

Output ONLY json lines or NONE."""

        rc3, tasks_out, _ = await run("claude", "--dangerously-skip-permissions", "--print", prompt)
        self.log_activity("builder", f"Claude returned: {tasks_out[:80]}{'...' if len(tasks_out) > 80 else ''}")

        if rc3 != 0 or is_rate_limited(tasks_out):
            wait = parse_retry_after(tasks_out)
            set_backoff(wait)
            self.log_activity("error", f"Rate limited — backing off {wait}s")
            return

        if not tasks_out or tasks_out.strip() == "NONE":
            self.log_activity("builder", "No new tasks found")
            return

        for task_line in tasks_out.splitlines():
            task_line = task_line.strip()
            if not task_line or task_line == "NONE":
                continue
            try:
                task = json.loads(task_line)
            except json.JSONDecodeError:
                continue

            title = task.get("title", "").strip()
            body = task.get("body", "").strip()
            if not title:
                continue

            self.log_activity("builder", f"Creating issue: {title}")
            rc4, issue_url = await gh(
                "issue", "create", "--repo", REPO, "--title", title, "--body", body,
            )
            m = re.search(r"(\d+)$", issue_url)
            if not m:
                continue
            issue_num = int(m.group(1))
            self.log_activity("builder", f"Created issue #{issue_num}")

            await gh(
                "issue", "comment", str(DISCUSSION_ISSUE), "--repo", REPO, "--body",
                f"🔨 **Vyshnav (Builder):** Picked this up → created #{issue_num}: **{title}**. Spinning up a worktree now.\n\n**— Vyshnav (simulated builder)**",
            )

            branch = f"feature/issue-{issue_num}"
            worktree = f"{REPO_ROOT}/.claude/worktrees/issue-{issue_num}"

            if Path(worktree).is_dir():
                self.log_activity("builder", f"Worktree {worktree} already exists, skipping")
                break

            await run("git", "-C", REPO_ROOT, "worktree", "add", worktree, "-b", branch)
            self.log_activity("builder", f"Worktree created at {worktree}")

            await tmux("new-session", "-d", "-s", BUILDER_SESSION)
            window = f"issue-{issue_num}"
            await tmux("new-window", "-t", BUILDER_SESSION, "-n", window)

            claude_prompt = (
                f"Implement GitHub issue #{issue_num} in this repo.\n\n"
                f"Title: {title}\n\nSpec:\n{body}\n\n"
                f"Instructions:\n"
                f"- Read the relevant source files first to understand the codebase\n"
                f"- Implement the feature in apps/server/src/\n"
                f"- Commit with a clear message (no Co-Authored-By)\n"
                f"- Push branch {branch}\n"
                f"- Open a PR to main referencing #{issue_num} in the PR body\n"
                f"- Work autonomously, do not ask for confirmation"
            )
            await tmux(
                "send-keys", "-t", f"{BUILDER_SESSION}:{window}",
                f"cd '{worktree}' && claude --dangerously-skip-permissions '{claude_prompt}'",
                "Enter",
            )
            self.log_activity("builder", f"Launched Claude in {BUILDER_SESSION}:{window} for issue #{issue_num}")
            break  # only create 1 issue per scan

    async def _resume_after_backoff(self) -> None:
        if in_backoff():
            return
        if not RL_RESUMED.exists():
            return
        RL_RESUMED.unlink(missing_ok=True)

        self.log_activity("builder", "Backoff cleared — sending 'continue' to idle Claude windows")
        for issue_num, worker in list(self._workers.items()):
            if worker.state == "idle":
                await tmux(
                    "send-keys", "-t", f"{BUILDER_SESSION}:{worker.window_idx}",
                    "continue with the task",
                    "Enter",
                )
                await asyncio.sleep(1)

    # ── Key actions ───────────────────────────────────────────────────────────

    def action_quit(self) -> None:
        self.exit()

    def action_rebase_check(self) -> None:
        self.log_activity("rebase", "Manual rebase check triggered")
        asyncio.create_task(self._notify_rebase())

    def action_force_scan(self) -> None:
        self._scan_countdown = SCAN_INTERVAL
        self.log_activity("info", "Manual scan triggered")
        asyncio.create_task(self._do_scan_cycle())

    async def action_focus_worker(self) -> None:
        # Simple: log list of active issues
        nums = sorted(self._workers.keys())
        self.log_activity("info", f"Active workers: {', '.join(f'#{n}' for n in nums)}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = BuilderApp()
    app.run()
