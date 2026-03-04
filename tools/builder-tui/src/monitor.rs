use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};

use crate::config::Config;
use crate::github;

// ─── BackoffState ────────────────────────────────────────────────────────────

pub struct BackoffState {
    until_unix: u64,
    pub needs_resume: bool,
}

impl BackoffState {
    pub fn new() -> Self {
        let until_unix = std::fs::read_to_string("/tmp/rl-backoff-until.txt")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);
        Self { until_unix, needs_resume: false }
    }

    pub fn in_backoff(&self) -> bool {
        self.until_unix > now_unix()
    }

    pub fn set(&mut self, wait_secs: u64) {
        self.until_unix = now_unix() + wait_secs + 30;
        let _ = std::fs::write("/tmp/rl-backoff-until.txt", self.until_unix.to_string());
        let _ = std::fs::write("/tmp/rl-resumed.txt", "");
        self.needs_resume = true;
    }

    pub fn clear(&mut self) {
        self.until_unix = 0;
        let _ = std::fs::remove_file("/tmp/rl-backoff-until.txt");
    }

    pub fn remaining_secs(&self) -> i64 {
        self.until_unix as i64 - now_unix() as i64
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn log(tx: &mpsc::UnboundedSender<String>, msg: impl Into<String>) {
    let _ = tx.send(msg.into());
}

fn toast(tx: &mpsc::UnboundedSender<String>, level: &str, msg: &str) {
    let _ = tx.send(format!("__TOAST_{level}_{msg}__"));
}

async fn capture_pane(config: &Config, idx: usize) -> String {
    let target = format!("{}:{}", config.session, idx);
    let Ok(out) = tokio::process::Command::new(&config.tmux)
        .args(["capture-pane", "-t", &target, "-p"])
        .output()
        .await
    else {
        return String::new();
    };
    String::from_utf8_lossy(&out.stdout).to_string()
}

async fn send_keys(config: &Config, target: &str, text: &str) {
    let _ = tokio::process::Command::new(&config.tmux)
        .args(["send-keys", "-t", target, text, "Enter"])
        .output()
        .await;
}

pub async fn list_windows(config: &Config) -> Vec<(usize, String)> {
    let Ok(out) = tokio::process::Command::new(&config.tmux)
        .args([
            "list-windows", "-t", &config.session,
            "-F", "#{window_index}:#{window_name}",
        ])
        .output()
        .await
    else {
        return Vec::new();
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let mut windows = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(2, ':');
        if let (Some(idx_str), Some(name)) = (parts.next(), parts.next()) {
            if let Ok(idx) = idx_str.parse::<usize>() {
                if name != "zsh" {
                    windows.push((idx, name.to_string()));
                }
            }
        }
    }
    windows
}

pub fn extract_issue_num(name: &str) -> Option<u64> {
    name.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .last()
        .and_then(|s| s.parse::<u64>().ok())
}

fn classify_pane(pane: &str) -> &'static str {
    let spinner_words = ["Crunching", "Brewing", "Baking", "Cogitating", "Thinking", "Analyzing"];
    if spinner_words.iter().any(|w| pane.contains(w)) {
        return "active";
    }
    if pane.contains("bypass permissions on") {
        return "claude_repl";
    }
    let is_shell = pane.lines().rev().take(5).any(|l| {
        let t = l.trim();
        t.starts_with("vyshnav@") || t.starts_with(">> ") || t == ">>"
    });
    if is_shell {
        return "shell";
    }
    "unknown"
}

// ─── ISO 8601 helpers ─────────────────────────────────────────────────────────

fn unix_to_iso8601(ts: u64) -> String {
    let time = ts % 86400;
    let h = time / 3600;
    let m = (time % 3600) / 60;
    let s = time % 60;
    let mut days = ts / 86400;

    let mut year = 1970u32;
    loop {
        let leap = is_leap(year);
        let days_in_year = if leap { 366u64 } else { 365u64 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }

    let months = if is_leap(year) {
        [31u64, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31u64, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1u32;
    for &dim in &months {
        if days < dim {
            break;
        }
        days -= dim;
        month += 1;
    }
    let day = days + 1;

    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

fn is_leap(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

// ─── Public functions ─────────────────────────────────────────────────────────

pub async fn count_active_workers(config: &Config) -> usize {
    let windows = list_windows(config).await;
    let mut count = 0;
    for (idx, _) in windows {
        let pane = capture_pane(config, idx).await;
        let s = classify_pane(&pane);
        if s == "active" || s == "claude_repl" {
            count += 1;
        }
    }
    count
}

pub async fn write_builder_status(config: &Config, _log_tx: &mpsc::UnboundedSender<String>) {
    let windows = list_windows(config).await;
    let mut prs: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for (_, name) in &windows {
        let Some(issue_num) = extract_issue_num(name) else { continue };
        if let Ok(pr_nums) = github::list_prs_for_issue(&config.repo, issue_num).await {
            if let Some(&pr_num) = pr_nums.first() {
                prs.insert(name.clone(), format!("#{pr_num}"));
            }
        }
    }

    let status = serde_json::json!({ "prs": prs });
    if let Ok(json) = serde_json::to_string(&status) {
        let _ = std::fs::write("/tmp/builder-status.json", json);
    }
}

pub async fn monitor_windows(
    config: &Config,
    _backoff: &Arc<Mutex<BackoffState>>,
    log_tx: &mpsc::UnboundedSender<String>,
) {
    let windows = list_windows(config).await;

    for (idx, name) in &windows {
        let Some(issue_num) = extract_issue_num(name) else { continue };
        let pane = capture_pane(config, *idx).await;
        let state = classify_pane(&pane);

        if state == "active" {
            continue;
        }

        let pr_nums = github::list_prs_for_issue(&config.repo, issue_num)
            .await
            .unwrap_or_default();
        let pr_exists = !pr_nums.is_empty();
        let target = format!("{}:{}", config.session, idx);

        if state == "claude_repl" && !pr_exists {
            log(
                log_tx,
                format!("[monitor] Issue #{issue_num}: Claude idle, no PR — nudging"),
            );
            toast(log_tx, "INFO", &format!("Nudged #{issue_num}"));
            let msg = format!(
                "Have you pushed the branch and opened a PR to main referencing #{}? If not, please do that now.",
                issue_num
            );
            send_keys(config, &target, &msg).await;

            let comment = format!(
                "🔧 **Vyshnav (Builder):** Nudged Claude on issue #{issue_num} — was idle without a PR.\n\n**— Vyshnav (simulated builder)**"
            );
            let _ = github::post_comment(&config.repo, config.discussion_issue, &comment).await;
        } else if state == "shell" && !pr_exists {
            let active = count_active_workers(config).await;
            if active >= config.max_concurrent {
                log(
                    log_tx,
                    format!(
                        "[monitor] Issue #{issue_num}: queued (at capacity {active}/{})",
                        config.max_concurrent
                    ),
                );
                continue;
            }

            let worktree = format!(
                "{}/.claude/worktrees/issue-{issue_num}",
                config.repo_root
            );
            if !std::path::Path::new(&worktree).exists() {
                continue;
            }

            let branch = format!("feature/issue-{issue_num}");
            let claude_prompt = format!(
                "Implement GitHub issue #{issue_num} in this repo. Push branch {branch} and open a PR to main referencing #{issue_num}. Work autonomously."
            );
            let escaped = claude_prompt.replace('\'', "'\\''");
            let cmd = format!(
                "cd '{}' && claude --dangerously-skip-permissions '{}'",
                worktree, escaped
            );
            send_keys(config, &target, &cmd).await;

            log(
                log_tx,
                format!("[monitor] Issue #{issue_num}: Claude exited without PR — relaunched"),
            );
            toast(log_tx, "WARNING", &format!("Relaunched #{issue_num}"));

            let comment = format!(
                "🔄 **Vyshnav (Builder):** Relaunched Claude on issue #{issue_num} — previous run exited without a PR.\n\n**— Vyshnav (simulated builder)**"
            );
            let _ = github::post_comment(&config.repo, config.discussion_issue, &comment).await;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    }
}

pub async fn cleanup_finished(config: &Config, log_tx: &mpsc::UnboundedSender<String>) {
    let windows = list_windows(config).await;

    for (idx, name) in &windows {
        let Some(issue_num) = extract_issue_num(name) else { continue };

        let state = github::get_issue_state(&config.repo, issue_num)
            .await
            .unwrap_or_default();
        if state != "CLOSED" {
            continue;
        }

        log(
            log_tx,
            format!("[cleanup] Issue #{issue_num} closed — removing window {idx} and worktree"),
        );
        toast(log_tx, "SUCCESS", &format!("Closed #{issue_num} — cleaned up"));

        let worktree = format!(
            "{}/.claude/worktrees/issue-{issue_num}",
            config.repo_root
        );
        if std::path::Path::new(&worktree).exists() {
            let _ = tokio::process::Command::new("git")
                .args(["-C", &config.repo_root, "worktree", "remove", "--force", &worktree])
                .output()
                .await;
        }

        let target = format!("{}:{}", config.session, idx);
        let _ = tokio::process::Command::new(&config.tmux)
            .args(["kill-window", "-t", &target])
            .output()
            .await;

        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }
}

const REBASE_CHECK_FILE: &str = "/tmp/builder-last-merge-check.txt";

pub async fn notify_rebase(config: &Config, log_tx: &mpsc::UnboundedSender<String>) {
    let last_check = std::fs::read_to_string(REBASE_CHECK_FILE)
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| unix_to_iso8601(now_unix().saturating_sub(600)));

    let now_ts = unix_to_iso8601(now_unix());
    let _ = std::fs::write(REBASE_CHECK_FILE, &now_ts);

    let merged = github::merged_prs_since(&config.repo, &last_check)
        .await
        .unwrap_or_default();
    if merged.is_empty() {
        return;
    }

    let merged_count = merged.len();
    log(log_tx, format!("[rebase] Detected {merged_count} merged PR(s) since {last_check}"));
    toast(log_tx, "INFO", &format!("{merged_count} PR(s) merged — rebasing"));

    // Pull latest main
    let _ = tokio::process::Command::new("git")
        .args(["-C", &config.repo_root, "fetch", "origin", "main", "--quiet"])
        .output()
        .await;

    let windows = list_windows(config).await;
    for (idx, name) in &windows {
        let Some(issue_num) = extract_issue_num(name) else { continue };
        let pane = capture_pane(config, *idx).await;
        let state = classify_pane(&pane);
        let target = format!("{}:{}", config.session, idx);

        if state == "claude_repl" {
            log(log_tx, format!("[rebase] Asking issue #{issue_num} worker to rebase"));
            send_keys(
                config,
                &target,
                "Some PRs just merged to main. Please run: git fetch origin && git rebase origin/main — then continue your work.",
            )
            .await;
        } else if state == "shell" {
            let worktree = format!(
                "{}/.claude/worktrees/issue-{issue_num}",
                config.repo_root
            );
            if !std::path::Path::new(&worktree).exists() {
                continue;
            }
            log(log_tx, format!("[rebase] Running rebase for issue #{issue_num} at shell"));
            let cmd = format!(
                "cd '{}' && git fetch origin && git rebase origin/main && echo '[rebase done]'",
                worktree
            );
            send_keys(config, &target, &cmd).await;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }
}

pub async fn resume_after_backoff(
    config: &Config,
    backoff: &Arc<Mutex<BackoffState>>,
    log_tx: &mpsc::UnboundedSender<String>,
) {
    // If still in backoff, skip
    if backoff.lock().await.in_backoff() {
        return;
    }
    // If no resume marker, skip
    if !std::path::Path::new("/tmp/rl-resumed.txt").exists() {
        return;
    }
    let _ = std::fs::remove_file("/tmp/rl-resumed.txt");
    backoff.lock().await.clear();

    log(log_tx, "[builder] Backoff cleared — sending 'continue' to idle Claude windows");
    toast(log_tx, "INFO", "Rate limit cleared");

    let windows = list_windows(config).await;
    for (idx, name) in &windows {
        if name == "zsh" { continue; }
        let pane = capture_pane(config, *idx).await;
        if pane.contains("bypass permissions on") {
            let target = format!("{}:{}", config.session, idx);
            send_keys(config, &target, "continue with the task").await;
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        }
    }
}
