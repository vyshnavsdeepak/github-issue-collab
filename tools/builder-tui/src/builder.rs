use std::path::Path;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};
use tokio::time::{Duration, sleep};

use crate::config::Config;
use crate::github;
use crate::monitor::BackoffState;

fn toast(tx: &mpsc::UnboundedSender<String>, level: &str, msg: &str) {
    let _ = tx.send(format!("__TOAST_{level}_{msg}__"));
}

#[derive(serde::Deserialize)]
struct Task {
    title: String,
    body: String,
}

fn log(tx: &mpsc::UnboundedSender<String>, msg: impl Into<String>) {
    let _ = tx.send(msg.into());
}

fn is_rate_limited(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("429")
        || lower.contains("too many requests")
        || lower.contains("try again in")
        || lower.contains("overloaded")
        || lower.contains("api error")
}

fn parse_retry_after(text: &str) -> u64 {
    let lower = text.to_lowercase();
    // "try again in N second(s)"
    if let Some(pos) = lower.find("try again in ") {
        let after = &lower[pos + 13..];
        let num_end = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
        if let Ok(n) = after[..num_end].parse::<u64>() {
            if after[num_end..].contains("minute") {
                return n * 60;
            }
            return n;
        }
    }
    120 // default 2 minutes
}

fn parse_tasks(output: &str) -> Vec<Task> {
    output
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && *l != "NONE")
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn build_prompt(discussion: &str, existing_str: &str) -> String {
    format!(
        r#"You are Vyshnav, a pragmatic builder. Read this product discussion and extract 1-2 concrete implementable tasks not already filed.

{discussion}

EXISTING OPEN ISSUES (do not duplicate):
{existing_str}

Rules:
- Only output tasks that are concrete and implementable in code
- Skip anything vague or already covered by existing issues
- If nothing new and concrete, output exactly: NONE

For each task output one JSON per line (no other text):
{{"title": "Short imperative title", "body": "Detailed spec of what to implement and why"}}

Output ONLY json lines or NONE."#
    )
}

async fn create_worktree(config: &Config, issue_num: u64, branch: &str, worktree: &str) -> anyhow::Result<()> {
    let out = tokio::process::Command::new("git")
        .args(["-C", &config.repo_root, "worktree", "add", worktree, "-b", branch])
        .output()
        .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("git worktree add failed for #{issue_num}: {stderr}");
    }
    Ok(())
}

pub async fn launch_worker(
    config: &Arc<Config>,
    issue_num: u64,
    title: &str,
    body: &str,
    log_tx: &mpsc::UnboundedSender<String>,
) {
    let branch = format!("feature/issue-{issue_num}");
    let worktree = format!("{}/.claude/worktrees/issue-{issue_num}", config.repo_root);

    if Path::new(&worktree).exists() {
        log(log_tx, format!("[builder] Worktree {worktree} already exists, reusing"));
    } else {
        if let Err(e) = create_worktree(config, issue_num, &branch, &worktree).await {
            log(log_tx, format!("[builder] {e}"));
            return;
        }
        log(log_tx, format!("[builder] Worktree created at {worktree}"));
    }

    // Ensure builder session exists
    let _ = tokio::process::Command::new(&config.tmux)
        .args(["new-session", "-d", "-s", &config.session])
        .output()
        .await;

    // Create tmux window
    let window = format!("issue-{issue_num}");
    let _ = tokio::process::Command::new(&config.tmux)
        .args(["new-window", "-t", &config.session, "-n", &window])
        .output()
        .await;

    let active = crate::monitor::count_active_workers(config).await;
    if active >= config.max_concurrent {
        log(
            log_tx,
            format!("[builder] Queued #{issue_num} (at capacity {active}/{})", config.max_concurrent),
        );
        return;
    }

    let claude_prompt = format!(
        "Implement GitHub issue #{issue_num} in this repo.\n\nTitle: {title}\n\nSpec:\n{body}\n\nInstructions:\n- Read the relevant source files first to understand the codebase\n- Implement the feature in apps/server/src/\n- Commit with a clear message (no Co-Authored-By)\n- Push branch {branch}\n- Open a PR to main referencing #{issue_num} in the PR body\n- Work autonomously, do not ask for confirmation"
    );

    let escaped = claude_prompt.replace('\'', "'\\''");
    let cmd = format!("cd '{}' && unset CLAUDECODE && claude --dangerously-skip-permissions '{}'", worktree, escaped);

    let target = format!("{}:{window}", config.session);
    let _ = tokio::process::Command::new(&config.tmux)
        .args(["send-keys", "-t", &target, &cmd, "Enter"])
        .output()
        .await;

    log(log_tx, format!("[builder] Launched Claude in {}:{window} for issue #{issue_num}", config.session));
}

async fn process_task(
    config: &Arc<Config>,
    task: &Task,
    log_tx: &mpsc::UnboundedSender<String>,
) {
    log(log_tx, format!("[builder] Creating issue: {}", task.title));

    let issue_num = match github::create_issue(&config.repo, &task.title, &task.body).await {
        Ok(n) => n,
        Err(e) => {
            log(log_tx, format!("[builder] Error creating issue: {e}"));
            return;
        }
    };

    log(log_tx, format!("[builder] Created issue #{issue_num}"));
    let title_preview: String = task.title.chars().take(30).collect();
    toast(log_tx, "SUCCESS", &format!("Filed #{issue_num}: {title_preview}"));

    let comment = format!(
        "🔨 **Vyshnav (Builder):** Picked this up → created #{}: **{}**. Spinning up a worktree now.\n\n**— Vyshnav (simulated builder)**",
        issue_num, task.title
    );
    let _ = github::post_comment(&config.repo, config.discussion_issue, &comment).await;

    launch_worker(config, issue_num, &task.title, &task.body, log_tx).await;
}

async fn handle_command(config: &Arc<Config>, cmd: &str, log_tx: &mpsc::UnboundedSender<String>) {
    let lower = cmd.to_lowercase();

    if lower.contains("rebase all") {
        log(log_tx, "[builder] Command: triggering rebase");
        crate::monitor::notify_rebase(config, log_tx).await;
    } else if lower.starts_with("nudge all") || lower.starts_with("broadcast ") {
        let msg = if lower.starts_with("broadcast ") {
            &cmd["broadcast ".len()..]
        } else {
            "continue with the task"
        };
        log(log_tx, format!("[builder] Command: broadcasting to idle workers: {msg}"));
        let windows = crate::monitor::list_windows(config).await;
        for (idx, _) in &windows {
            let pane = {
                let target = format!("{}:{}", config.session, idx);
                tokio::process::Command::new(&config.tmux)
                    .args(["capture-pane", "-t", &target, "-p"])
                    .output()
                    .await
                    .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                    .unwrap_or_default()
            };
            if pane.contains("bypass permissions on") {
                let target = format!("{}:{}", config.session, idx);
                let _ = tokio::process::Command::new(&config.tmux)
                    .args(["send-keys", "-t", &target, msg, "Enter"])
                    .output()
                    .await;
            }
        }
    } else {
        // Pass through as-is to a log message — future: could invoke claude with command
        log(log_tx, format!("[builder] Unrecognized command (logged only): {cmd}"));
    }
}

pub async fn run(
    config: Arc<Config>,
    log_tx: mpsc::UnboundedSender<String>,
    backoff: Arc<Mutex<BackoffState>>,
    mut cmd_rx: mpsc::UnboundedReceiver<String>,
) {
    log(&log_tx, "[builder] Starting builder loop...");

    loop {
        // Drain any pending commands first (higher priority than scheduled scan)
        while let Ok(cmd) = cmd_rx.try_recv() {
            log(&log_tx, format!("[builder] Command received: {cmd}"));
            handle_command(&config, &cmd, &log_tx).await;
        }

        // Check backoff
        {
            let state = backoff.lock().await;
            if state.in_backoff() {
                let remaining = state.remaining_secs();
                log(&log_tx, format!("[builder] In backoff, {remaining}s remaining. Sleeping 30s..."));
                drop(state);
                sleep(Duration::from_secs(30)).await;
                continue;
            }
        }

        // Resume after backoff
        crate::monitor::resume_after_backoff(&config, &backoff, &log_tx).await;

        // Read discussion
        log(&log_tx, "[builder] Reading discussion...");
        let discussion = match github::get_discussion(&config.repo, config.discussion_issue).await {
            Ok(d) => d,
            Err(e) => {
                log(&log_tx, format!("[builder] Error reading discussion: {e}"));
                sleep(Duration::from_secs(30)).await;
                continue;
            }
        };

        // List existing issues
        let existing = match github::list_open_issues(&config.repo).await {
            Ok(e) => e,
            Err(e) => {
                log(&log_tx, format!("[builder] Error listing issues: {e}"));
                sleep(Duration::from_secs(30)).await;
                continue;
            }
        };

        let existing_str = existing
            .iter()
            .map(|(n, t)| format!("#{n}: {t}"))
            .collect::<Vec<_>>()
            .join("\n");

        let prompt = build_prompt(&discussion, &existing_str);

        log(&log_tx, "[builder] Calling Claude to extract tasks...");
        let tasks_output = match github::invoke_claude(&prompt).await {
            Ok(t) => t,
            Err(e) => {
                let err_str = e.to_string();
                if is_rate_limited(&err_str) {
                    let wait = parse_retry_after(&err_str);
                    log(&log_tx, format!("[builder] Rate limited, backing off {wait}s"));
                    toast(&log_tx, "WARNING", &format!("Rate limited — {wait}s"));
                    backoff.lock().await.set(wait);
                    sleep(Duration::from_secs(30)).await;
                    continue;
                }
                log(&log_tx, format!("[builder] Claude error: {e}"));
                sleep(Duration::from_secs(30)).await;
                continue;
            }
        };

        let preview: String = tasks_output.chars().take(120).collect();
        log(&log_tx, format!("[builder] Claude returned: {preview}"));

        if !tasks_output.trim().is_empty() && tasks_output.trim() != "NONE" {
            let tasks = parse_tasks(&tasks_output);
            if let Some(task) = tasks.into_iter().next() {
                process_task(&config, &task, &log_tx).await;
            } else {
                log(&log_tx, "[builder] No valid task JSON found in Claude output.");
            }
        } else {
            log(&log_tx, "[builder] No new tasks.");
        }

        // Write status, monitor, notify, cleanup
        log(&log_tx, "[builder] Writing builder status...");
        crate::monitor::write_builder_status(&config, &log_tx).await;

        log(&log_tx, "[builder] Monitoring windows...");
        crate::monitor::monitor_windows(&config, &backoff, &log_tx).await;

        log(&log_tx, "[builder] Promoting orphaned worktrees...");
        crate::monitor::promote_orphaned_worktrees(&config, &log_tx).await;

        log(&log_tx, "[builder] Checking for merged PRs...");
        crate::monitor::notify_rebase(&config, &log_tx).await;

        log(&log_tx, "[builder] Cleaning up finished windows...");
        crate::monitor::cleanup_finished(&config, &log_tx).await;

        // Signal countdown to TUI
        let _ = log_tx.send(format!("__NEXT_SCAN_{}__", config.builder_sleep_secs));
        log(&log_tx, format!("[builder] Sleeping {}s before next scan...", config.builder_sleep_secs));
        sleep(Duration::from_secs(config.builder_sleep_secs)).await;
    }
}
