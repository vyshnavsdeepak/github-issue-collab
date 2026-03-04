use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{mpsc, watch};

#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct BuilderStatus {
    #[serde(default)]
    pub prs: HashMap<String, String>, // window_name -> PR number
}

#[derive(Debug, Clone)]
pub struct WorkerState {
    pub window_index: usize,
    pub window_name: String,
    /// Pane/Claude state: "active" | "idle" | "shell" | "done" | "queued" | "sleeping" | "posted" | "no-window"
    pub status: String,
    pub pr: Option<String>,
    pub last_output: String,
    /// Whether the worktree directory exists on disk
    pub worktree_exists: bool,
    /// The feature branch name for this issue
    pub branch_name: String,
    /// Richer pipeline status for at-a-glance: WT→BR→PR
    pub pipeline: String,
}

fn compute_pipeline(worktree_exists: bool, branch_name: &str, pr: &Option<String>, status: &str) -> String {
    let wt = if worktree_exists { "🌳" } else { "·" };
    // Check if branch exists via git
    let br = if worktree_exists { "🌿" } else { "·" };
    let pr_part = match pr {
        Some(p) => p.clone(),
        None => "·".to_string(),
    };
    let state = match status {
        "active" => "⚡",
        "idle" => "⏸",
        "shell" => "🐚",
        "done" => "✅",
        "queued" => "⏳",
        "sleeping" => "💤",
        "posted" => "📮",
        "no-window" => "👻",
        "conflict" => "⚠️",
        _ => "?",
    };
    let _ = branch_name;
    format!("{wt}{br}{pr_part} {state}")
}

pub async fn run(
    session: String,
    interval_secs: u64,
    tx: watch::Sender<Vec<WorkerState>>,
    log_tx: mpsc::UnboundedSender<String>,
    repo_root: String,
    is_polling: Arc<AtomicBool>,
) {
    let mut prev_states: HashMap<String, String> = HashMap::new();
    // Slow scan every max(interval_secs, 60) seconds; counter ticks every 1s
    let slow_every = interval_secs.max(60);
    let mut slow_counter: u64 = 0;
    let mut first_run = true;

    loop {
        is_polling.store(true, Ordering::Relaxed);

        let do_slow = slow_counter == 0;
        slow_counter = (slow_counter + 1) % slow_every;

        let builder_status = load_builder_status();

        // Fast path: get tmux windows
        let mut states = poll_tmux_windows(&session, &builder_status, &repo_root);

        // Slow path: merge orphaned worktrees
        if (do_slow || first_run) && !repo_root.is_empty() {
            let worktree_issues = scan_worktrees(&repo_root);
            let tmux_names: Vec<String> = states.iter().map(|w| w.window_name.clone()).collect();

            let mut orphan_count = 0;
            for issue_num in worktree_issues {
                let name = format!("issue-{issue_num}");
                if !tmux_names.contains(&name) {
                    let pr = builder_status.prs.get(&name).cloned();
                    let worktree_path = format!("{repo_root}/.claude/worktrees/{name}");
                    let worktree_exists = std::path::Path::new(&worktree_path).exists();
                    let branch_name = format!("feature/issue-{issue_num}");
                    let pipeline = compute_pipeline(worktree_exists, &branch_name, &pr, "no-window");
                    states.push(WorkerState {
                        window_index: usize::MAX,
                        window_name: name,
                        status: "no-window".to_string(),
                        pr,
                        last_output: "(orphaned worktree)".to_string(),
                        worktree_exists,
                        branch_name,
                        pipeline,
                    });
                    orphan_count += 1;
                }
            }

            if first_run {
                let total = states.len();
                let msg = if orphan_count > 0 {
                    format!("__TOAST_INFO_Loaded {total} workers ({orphan_count} orphaned)__")
                } else {
                    format!("__TOAST_INFO_Loaded {total} workers__")
                };
                let _ = log_tx.send(msg);
                first_run = false;
            }
        }

        // Detect state transitions
        for w in &states {
            if let Some(prev) = prev_states.get(&w.window_name) {
                if prev != &w.status {
                    let toast = match (prev.as_str(), w.status.as_str()) {
                        (p, "active") if p != "active" => {
                            Some(format!("__TOAST_INFO_{} started working__", w.window_name))
                        }
                        ("active", "done") => {
                            Some(format!("__TOAST_SUCCESS_{} has a PR!__", w.window_name))
                        }
                        ("shell", "idle") => {
                            Some(format!("__TOAST_INFO_{} Claude relaunched__", w.window_name))
                        }
                        (_, "no-window") => {
                            Some(format!("__TOAST_WARNING_{} window lost__", w.window_name))
                        }
                        _ => None,
                    };
                    if let Some(msg) = toast {
                        let _ = log_tx.send(msg);
                    }
                }
            }
        }

        // Update prev states
        prev_states.clear();
        for w in &states {
            prev_states.insert(w.window_name.clone(), w.status.clone());
        }

        let _ = tx.send(states);
        is_polling.store(false, Ordering::Relaxed);

        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }
}

/// Scan `.claude/worktrees/` for `issue-N` directories and return sorted issue numbers.
pub fn scan_worktrees(repo_root: &str) -> Vec<u64> {
    let worktrees_dir = format!("{repo_root}/.claude/worktrees");
    let Ok(entries) = std::fs::read_dir(&worktrees_dir) else {
        return Vec::new();
    };

    let mut issues: Vec<u64> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("issue-") {
                name_str["issue-".len()..].parse::<u64>().ok()
            } else {
                None
            }
        })
        .collect();

    issues.sort_unstable();
    issues
}

fn poll_tmux_windows(session: &str, builder_status: &BuilderStatus, repo_root: &str) -> Vec<WorkerState> {
    let Ok(out) = std::process::Command::new("/opt/homebrew/bin/tmux")
        .args(["list-windows", "-t", session, "-F", "#{window_index} #{window_name}"])
        .output()
    else {
        return Vec::new();
    };

    let windows_text = String::from_utf8_lossy(&out.stdout);
    let mut states = Vec::new();

    for line in windows_text.lines() {
        let mut parts = line.splitn(2, ' ');
        let Some(idx_str) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        let Ok(idx) = idx_str.parse::<usize>() else { continue };

        let pane_content = capture_pane(session, idx);
        let last_output = last_nonempty_line(&pane_content);
        let pr = builder_status.prs.get(name).cloned();
        let status = classify_state(&pane_content, pr.is_some());

        // Derive issue number from window name to locate worktree
        let issue_num_opt: Option<u64> = name
            .split(|c: char| !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .last()
            .and_then(|s| s.parse().ok());
        let (worktree_exists, branch_name) = if let Some(n) = issue_num_opt {
            let wt = format!("{repo_root}/.claude/worktrees/issue-{n}");
            let br = format!("feature/issue-{n}");
            (std::path::Path::new(&wt).exists(), br)
        } else {
            (false, String::new())
        };
        // Conflict marker overrides status
        let status = match issue_num_opt {
            Some(n) if crate::monitor::has_conflict_marker(n) => "conflict".to_string(),
            _ => status,
        };
        let pipeline = compute_pipeline(worktree_exists, &branch_name, &pr, &status);

        states.push(WorkerState {
            window_index: idx,
            window_name: name.to_string(),
            status,
            pr,
            last_output,
            worktree_exists,
            branch_name,
            pipeline,
        });
    }

    states
}

fn capture_pane(session: &str, window_index: usize) -> String {
    let target = format!("{}:{}", session, window_index);
    let Ok(out) = std::process::Command::new("/opt/homebrew/bin/tmux")
        .args(["capture-pane", "-t", &target, "-p"])
        .output()
    else {
        return String::new();
    };
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn last_nonempty_line(content: &str) -> String {
    content
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .chars()
        .take(80)
        .collect()
}

fn classify_state(pane: &str, has_pr: bool) -> String {
    let spinner_words = ["Crunching", "Brewing", "Baking", "Cogitating", "Thinking", "Analyzing"];
    let is_active = spinner_words.iter().any(|w| pane.contains(w));

    // Claude REPL markers: startup banner or the ">" input prompt with surrounding Claude UI
    let has_bypass = pane.contains("bypass permissions on");
    // Claude's REPL prompt appears as "> " or "╭─" prefix lines (input area)
    let has_claude_prompt = pane.contains("> ") && (has_bypass || pane.contains("claude"));

    // Shell prompt detection — last few lines start with shell prompt chars
    let is_shell = pane.lines().rev().take(5).any(|l| {
        let t = l.trim();
        t.starts_with("vyshnav@") || t.starts_with(">> ") || t == ">>"
    });
    let is_sleeping = pane.contains("Sleeping ");
    let has_posted = pane.contains("posted a comment");
    // Detect PR creation: Claude prints the GitHub PR URL when creating one.
    // This is the most reliable "done" signal — catches the case where Claude
    // exits to shell before builder-status.json is updated.
    let pr_url_in_pane = pane.contains("/pull/")
        && (pane.contains("github.com/") || pane.contains("Created pull request"));

    if is_active {
        "active".to_string()
    } else if has_posted {
        "posted".to_string()
    } else if is_sleeping {
        "sleeping".to_string()
    } else if (has_bypass || has_claude_prompt) && (has_pr || pr_url_in_pane) {
        "done".to_string()
    } else if has_bypass || has_claude_prompt {
        "idle".to_string()
    } else if is_shell && (has_pr || pr_url_in_pane) {
        // Claude created a PR and exited — done, do not relaunch
        "done".to_string()
    } else if is_shell {
        // Shell visible — Claude exited. Distinguish: had Claude trace = needs relaunch; fresh = queued.
        let had_claude = pane.contains("claude")
            || pane.contains("Implement")
            || pane.contains("feature/issue-");
        if had_claude {
            "shell".to_string()
        } else {
            "queued".to_string()
        }
    } else {
        "unknown".to_string()
    }
}

fn load_builder_status() -> BuilderStatus {
    let path = "/tmp/builder-status.json";
    let Ok(content) = std::fs::read_to_string(path) else {
        return BuilderStatus::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}
